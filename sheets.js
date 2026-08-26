// sheets.js — Google Sheets API v4 integration (client-side OAuth2)
const SheetsAPI = (() => {
  const OWN_SHEET_NAME = 'Devoluciones';
  const OWN_HEADERS = ['Fecha', 'Cliente', 'Cantidad', 'Usuario', 'Observaciones'];
  const CLIENTES_SHEET_NAME = 'ClientesConfig';
  const CLIENTES_HEADERS = ['Original', 'MostrarComo', 'Excluir'];
  const ACCESOS_SHEET_NAME = 'Accesos';
  const ACCESOS_HEADERS = ['Fecha y hora', 'Nombre', 'Email', 'Rol'];

  let _ownSheetId = '';
  let _cargasSheetId = '';
  let _cargasTab = 'Cargas';
  let _pedidosTab = 'PEDIDOS';
  let _tokenClient = null;
  let _gapiReady = false;
  let _gsiReady = false;
  let _cache = {};
  let _userInfo = null;
  let _canEdit = false;

  // Duración propia de la sesión guardada en sessionStorage: más corta que
  // la hora que da Google, para no dejar el token vivo más de lo necesario.
  // sessionStorage (no localStorage) además se borra solo al cerrar la
  // pestaña/navegador, así no queda una sesión "para siempre" en el equipo.
  const SESSION_TTL_MS = 15 * 60 * 1000;
  // El sufijo "_v2" fuerza a descartar sesiones guardadas con el scope viejo
  // (sin email) cuando se agregó userinfo.email — si no, un token guardado
  // sin ese permiso se reusaría igual y el email seguiría viniendo vacío.
  const SESSION_KEY = 'palets_session_v2';

  function _saveSession(clientId, ownSheetId, accessToken) {
    sessionStorage.setItem(SESSION_KEY, JSON.stringify({
      clientId, ownSheetId, accessToken, expiresAt: Date.now() + SESSION_TTL_MS
    }));
  }

  function _loadValidSession(clientId, ownSheetId) {
    try {
      const raw = sessionStorage.getItem(SESSION_KEY);
      if (!raw) return null;
      const s = JSON.parse(raw);
      if (s.clientId !== clientId || s.ownSheetId !== ownSheetId) return null;
      if (Date.now() >= s.expiresAt) return null;
      return s.accessToken;
    } catch (e) {
      return null;
    }
  }

  function _clearSession() {
    sessionStorage.removeItem(SESSION_KEY);
  }

  // ── Init ───────────────────────────────────────────────────────────────────
  // CLAVE: el pedido de login a Google (requestAccessToken) tiene que salir
  // SINCRÓNICAMENTE, en el mismo instante del click del usuario. Si primero
  // esperamos a que cargue gapi.client (red, discovery docs), el navegador ya
  // no lo considera parte de "un toque real" y bloquea el popup en silencio
  // — la conexión queda esperando para siempre. Por eso gapi.client se carga
  // en paralelo, y el pedido de token no lo espera.
  function init(clientId, ownSheetId, cargasSheetId, cargasTab, pedidosTab) {
    _ownSheetId = ownSheetId;
    _cargasSheetId = cargasSheetId;
    _cargasTab = cargasTab || 'Cargas';
    _pedidosTab = pedidosTab || 'PEDIDOS';
    localStorage.setItem('palets_clientId', clientId);
    localStorage.setItem('palets_ownSheetId', ownSheetId);

    const gapiClientReady = new Promise((resolve, reject) => {
      gapi.load('client', async () => {
        try {
          await gapi.client.init({
            discoveryDocs: [
              'https://sheets.googleapis.com/$discovery/rest?version=v4',
              'https://www.googleapis.com/discovery/v1/apis/drive/v3/rest'
            ]
          });
          _gapiReady = true;
          resolve();
        } catch (e) { reject(e); }
      });
    });
    _gsiReady = true;

    return new Promise((resolve, reject) => {
      async function afterAuth(accessToken) {
        await gapiClientReady;
        gapi.client.setToken({ access_token: accessToken });
        // userinfo y capabilities son independientes entre sí — en paralelo
        // en vez de uno atrás del otro ahorra un viaje de red completo.
        await Promise.all([_fetchUserInfo(accessToken), _fetchCanEdit()]);
        if (_userInfo && _userInfo.email) localStorage.setItem('palets_lastEmail', _userInfo.email);
        if (_canEdit) await _ensureOwnSheet();
      }

      function requestFreshToken() {
        _tokenClient = google.accounts.oauth2.initTokenClient({
          client_id: clientId,
          scope: [
            'https://www.googleapis.com/auth/spreadsheets',
            'https://www.googleapis.com/auth/userinfo.profile',
            'https://www.googleapis.com/auth/userinfo.email',
            'https://www.googleapis.com/auth/drive.metadata.readonly'
          ].join(' '),
          callback: async (resp) => {
            if (resp.error) { reject(resp); return; }
            try {
              _saveSession(clientId, ownSheetId, resp.access_token);
              await afterAuth(resp.access_token);
              resolve(true);
            } catch (e) { reject(e); }
          }
        });
        // Sin "prompt: consent" fijo: Google solo vuelve a mostrar la
        // pantalla de permisos si es la primera vez o si cambiaron los
        // scopes pedidos; en reconexiones normales pasa directo.
        // "login_hint" con el último email usado evita que, con varias
        // cuentas de Google logueadas en el navegador, tenga que preguntar
        // cuál usar cada vez.
        const lastEmail = localStorage.getItem('palets_lastEmail');
        _tokenClient.requestAccessToken(lastEmail ? { prompt: '', hint: lastEmail } : { prompt: '' });
      }

      // Si hay un token de sesión propio (≤15 min) todavía válido, lo
      // reusamos directo (no hace falta popup, no hay problema de gesto).
      const savedToken = _loadValidSession(clientId, ownSheetId);
      if (savedToken) {
        afterAuth(savedToken)
          .then(() => resolve(true))
          .catch(() => {
            // El token guardado dejó de servir (ej. Google lo revocó antes
            // de los 15 min) — pedimos uno nuevo.
            _clearSession();
            requestFreshToken();
          });
      } else {
        requestFreshToken();
      }
    });
  }

  function signOut() {
    const token = gapi.client.getToken();
    if (token) {
      google.accounts.oauth2.revoke(token.access_token);
      gapi.client.setToken('');
    }
    _clearSession();
    _userInfo = null;
    _canEdit = false;
  }

  // Permiso real del usuario logueado sobre la Sheet de devoluciones:
  // se apoya en los permisos nativos de Google Drive (Editor/Lector) en vez
  // de inventar un sistema de roles propio — el "administrador" es quien
  // gestiona el compartir de esa hoja desde Google Drive.
  // Si la detección falla (ej. Drive API no habilitada en el proyecto de
  // Google Cloud), asumimos Editor por defecto: es más seguro trabar a un
  // Lector real con un error de permiso al guardar que dejar afuera por
  // error a alguien que sí tiene acceso.
  let _canEditDetected = true;
  async function _fetchCanEdit() {
    try {
      const res = await gapi.client.drive.files.get({ fileId: _ownSheetId, fields: 'capabilities' });
      _canEdit = !!(res.result.capabilities && res.result.capabilities.canEdit);
      _canEditDetected = true;
    } catch (e) {
      console.warn('No se pudo detectar el permiso (Editor/Lector) vía Drive API, asumiendo Editor:', e);
      _canEdit = true;
      _canEditDetected = false;
    }
  }

  function canEdit() { return _canEdit; }
  function canEditDetected() { return _canEditDetected; }

  async function _fetchUserInfo(accessToken) {
    try {
      const res = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
        headers: { Authorization: `Bearer ${accessToken}` }
      });
      _userInfo = await res.json();
    } catch (e) {
      _userInfo = null;
    }
  }

  function getUserName() {
    return (_userInfo && (_userInfo.name || _userInfo.email)) || 'Desconocido';
  }

  function getUserEmail() {
    return (_userInfo && _userInfo.email) || '';
  }

  // ── Internal helpers ───────────────────────────────────────────────────────
  async function _getSheetsList(spreadsheetId) {
    const res = await gapi.client.sheets.spreadsheets.get({ spreadsheetId });
    return res.result.sheets.map(s => s.properties.title);
  }

  // Solo hace falta chequear/escribir encabezados en las hojas RECIÉN
  // creadas — las que ya existían de una conexión anterior ya los tienen
  // (los pusimos nosotros mismos la primera vez). Evitar ese chequeo para
  // las que ya existen ahorra 3 viajes de red en el caso normal (usuario
  // que ya usó la app antes), que era la mayor parte de la demora al
  // conectar.
  async function _ensureOwnSheet() {
    const existing = await _getSheetsList(_ownSheetId);
    const specs = [
      { name: OWN_SHEET_NAME, headers: OWN_HEADERS },
      { name: CLIENTES_SHEET_NAME, headers: CLIENTES_HEADERS },
      { name: ACCESOS_SHEET_NAME, headers: ACCESOS_HEADERS }
    ];
    const missing = specs.filter(s => !existing.includes(s.name));
    if (!missing.length) return;

    await gapi.client.sheets.spreadsheets.batchUpdate({
      spreadsheetId: _ownSheetId,
      resource: { requests: missing.map(s => ({ addSheet: { properties: { title: s.name } } })) }
    });
    await Promise.all(missing.map(s => _writeRange(_ownSheetId, `${s.name}!A1`, [s.headers])));
  }

  // Registra cada login en la hoja "Accesos" (Fecha, Nombre, Email, Rol).
  // Best-effort: si falla (ej. la cuenta es Lector y no tiene permiso de
  // escritura), no rompe el login — solo se pierde ese registro puntual.
  async function logAccess(nombre) {
    try {
      const row = [
        new Date().toLocaleString('es-AR'),
        nombre || '',
        (_userInfo && _userInfo.email) || '',
        _canEdit ? 'Editor' : 'Lector'
      ];
      await _writeRange(_ownSheetId, `${ACCESOS_SHEET_NAME}!A1`, [row]);
    } catch (e) {
      console.warn('No se pudo registrar el acceso en la hoja Accesos:', e);
    }
  }

  async function _readRange(spreadsheetId, range, skipCache) {
    const key = spreadsheetId + '::' + range;
    if (!skipCache && _cache[key] && Date.now() - _cache[key].ts < 120000) return _cache[key].data;
    const res = await gapi.client.sheets.spreadsheets.values.get({ spreadsheetId, range });
    const data = res.result.values || [];
    _cache[key] = { data, ts: Date.now() };
    return data;
  }

  // Con valueInputOption USER_ENTERED, Sheets interpreta un valor que empieza
  // con =, +, -, @ (o tab) como fórmula, no como texto — es un vector de
  // inyección de fórmulas conocido si ese texto viene de un formulario
  // (ej. alguien escribe "=IMPORTXML(...)" como nombre de cliente). Se
  // neutraliza anteponiendo un apóstrofo, igual que hace la UI de Sheets con
  // "Forzar texto sin formato".
  function _sanitizeCell(value) {
    if (typeof value !== 'string') return value;
    return /^[=+\-@\t]/.test(value) ? `'${value}` : value;
  }

  function _sanitizeRows(rows) {
    return rows.map(row => row.map(_sanitizeCell));
  }

  async function _writeRange(spreadsheetId, range, values) {
    _cache = {}; // invalidate cache on write
    return gapi.client.sheets.spreadsheets.values.append({
      spreadsheetId, range,
      valueInputOption: 'USER_ENTERED',
      resource: { values: _sanitizeRows(values) }
    });
  }

  // Reemplaza el contenido completo de una hoja (se usa para guardar la
  // tabla de configuración de clientes, que el editor reescribe entera).
  async function _replaceSheet(spreadsheetId, sheetName, headers, rows) {
    _cache = {};
    await gapi.client.sheets.spreadsheets.values.clear({ spreadsheetId, range: `${sheetName}!A1:ZZ` });
    await gapi.client.sheets.spreadsheets.values.update({
      spreadsheetId, range: `${sheetName}!A1`,
      valueInputOption: 'USER_ENTERED',
      resource: { values: _sanitizeRows([headers, ...rows]) }
    });
  }

  function _rowsToObjects(rows) {
    if (!rows || rows.length < 2) return [];
    const headers = rows[0].map(h => (h || '').toString().trim());
    return rows.slice(1).map(row => {
      const obj = {};
      headers.forEach((h, i) => { obj[h] = row[i] !== undefined ? row[i] : ''; });
      return obj;
    });
  }

  // Como un usuario Lector no puede crear las hojas propias (Devoluciones,
  // ClientesConfig) si todavía no existen, tratamos "la hoja no existe" como
  // "sin datos" en vez de reventar toda la carga.
  async function _readRangeOrEmpty(spreadsheetId, range) {
    try {
      return await _readRange(spreadsheetId, range, true);
    } catch (e) {
      const msg = (e && e.result && e.result.error && e.result.error.message) || '';
      if (/unable to parse range/i.test(msg)) return [];
      throw e;
    }
  }

  function _findHeader(headers, candidates) {
    const norm = s => (s || '').toString().trim().toLowerCase();
    const idx = headers.findIndex(h => candidates.includes(norm(h)));
    return idx;
  }

  // ── Público: Cargas (solo lectura, sheet de administración) ─────────────────
  // Sin caché: es la fuente de la verdad de palets salidos y cambia seguido
  // en el Sheets de administración, tiene que reflejarse apenas se sincroniza.
  async function readCargas() {
    const rows = await _readRange(_cargasSheetId, `${_cargasTab}!A1:ZZ`, true);
    if (!rows || rows.length < 2) return [];
    const headers = rows[0].map(h => (h || '').toString().trim());
    const idxCliente = _findHeader(headers, ['cliente']);
    const idxPalets = _findHeader(headers, ['palets', 'palet']);
    if (idxCliente === -1) throw new Error(`No se encontró la columna "CLIENTE" en la hoja "${_cargasTab}"`);
    if (idxPalets === -1) throw new Error(`No se encontró la columna "Palets" en la hoja "${_cargasTab}". Agregala primero.`);

    return rows.slice(1)
      .map(row => ({
        cliente: (row[idxCliente] || '').toString().trim(),
        palets: parseFloat(row[idxPalets]) || 0
      }))
      .filter(r => r.cliente);
  }

  // ── Público: Pedidos (solo lectura, sheet de administración) ─────────────────
  async function readPedidos() {
    const rows = await _readRange(_cargasSheetId, `${_pedidosTab}!A1:ZZ`, true);
    if (!rows || rows.length < 2) return [];
    const headers = rows[0].map(h => (h || '').toString().trim());
    const idxCliente = _findHeader(headers, ['cliente']);
    const idxObs = _findHeader(headers, ['observaciones']);
    if (idxCliente === -1) throw new Error(`No se encontró la columna "CLIENTE" en la hoja "${_pedidosTab}"`);

    return rows.slice(1)
      .map(row => ({
        cliente: (row[idxCliente] || '').toString().trim(),
        observaciones: idxObs === -1 ? '' : (row[idxObs] || '').toString()
      }))
      .filter(r => r.cliente);
  }

  // ── Público: Config de clientes (propio — unifica nombres / excluye) ─────────
  async function readClientesConfig() {
    const rows = await _readRangeOrEmpty(_ownSheetId, `${CLIENTES_SHEET_NAME}!A:C`);
    return _rowsToObjects(rows).map(r => ({
      original: (r['Original'] || '').trim(),
      mostrarComo: (r['MostrarComo'] || '').trim(),
      excluir: /^(si|sí|true|1)$/i.test((r['Excluir'] || '').trim())
    })).filter(r => r.original);
  }

  async function saveClientesConfig(list) {
    const rows = list.map(c => [c.original, c.mostrarComo || '', c.excluir ? 'Si' : '']);
    return _replaceSheet(_ownSheetId, CLIENTES_SHEET_NAME, CLIENTES_HEADERS, rows);
  }

  // ── Público: Devoluciones (propio) ───────────────────────────────────────────
  async function readDevoluciones() {
    const rows = await _readRangeOrEmpty(_ownSheetId, `${OWN_SHEET_NAME}!A:E`);
    return _rowsToObjects(rows);
  }

  async function appendDevolucion(record) {
    const row = [record.fecha, record.cliente, record.cantidad, record.usuario, record.observaciones || ''];
    return _writeRange(_ownSheetId, `${OWN_SHEET_NAME}!A1`, [row]);
  }

  function isReady() { return _gapiReady && _gsiReady; }

  return {
    init, signOut, isReady, getUserName, getUserEmail, canEdit, canEditDetected,
    readCargas, readPedidos, readDevoluciones, appendDevolucion,
    readClientesConfig, saveClientesConfig, logAccess
  };
})();
