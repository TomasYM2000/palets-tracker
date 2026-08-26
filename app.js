// app.js — Main application logic
'use strict';

const CONFIG = {
  CLIENT_ID: '256488140515-6imleh7dn02li22va3l5466eg37o1nie.apps.googleusercontent.com',
  OWN_SHEET_ID: '1IYXnocNrVX2NveS9arK7uIP3QKagKrXhWqeMzFvpPJE',
  CARGAS_SHEET_ID: '13w33rmB7HmSMushiFdt7kwJZJoSsietlBmqs23-JUCQ',
  CARGAS_TAB: 'Cargas',
  PEDIDOS_TAB: 'PEDIDOS',
  // Ojo: esto es visible para cualquiera que mire el código fuente de la
  // página — es un filtro liviano contra curiosos, NO una barrera de
  // seguridad real. La protección real es (1) la lista de usuarios de
  // prueba en Google Cloud, que bloquea el login de cuentas no autorizadas,
  // y (2) los permisos de Editor/Lector del Sheets de devoluciones.
  ACCESS_CODE: 'Belipel2026'
};

const App = (() => {
  let _cargas = [];
  let _pedidos = [];
  let _devoluciones = [];
  let _clientesConfig = [];
  let _saldos = [];
  let _chequeo = [];
  let _clientesEditables = [];

  // Las llamadas a gapi/Sheets a veces rechazan con un objeto plano
  // ({result:{error:{message}}}) en vez de un Error real, donde e.message
  // queda undefined — esto extrae un texto legible en cualquier caso.
  function errMsg(e) {
    if (!e) return 'Error desconocido';
    if (e.result && e.result.error && e.result.error.message) return e.result.error.message;
    if (e.message) return e.message;
    try { return JSON.stringify(e); } catch { return String(e); }
  }

  // ── Toast ───────────────────────────────────────────────────────────────────
  function toast(msg, type = 'info') {
    const el = document.createElement('div');
    el.className = `toast toast-${type}`;
    el.textContent = msg;
    document.getElementById('toast-container').appendChild(el);
    setTimeout(() => el.classList.add('show'), 10);
    setTimeout(() => { el.classList.remove('show'); setTimeout(() => el.remove(), 300); }, 3500);
  }

  // ── Nombre del usuario (reemplaza el nombre/email de Google en "Usuario") ───
  function getDisplayName() {
    return localStorage.getItem('palets_displayName') || '';
  }

  function showWelcome() {
    document.getElementById('modal-welcome').style.display = 'flex';
  }

  function showSettings() {
    document.getElementById('input-nombre-editar').value = getDisplayName();
    document.getElementById('modal-settings').style.display = 'flex';
  }

  function showGuide() {
    document.getElementById('modal-guide').style.display = 'flex';
  }

  function showReconnect() {
    document.getElementById('reconnect-nombre').textContent = `Hola ${getDisplayName()}, tocá para conectarte con Google y seguir.`;
    document.getElementById('modal-reconnect').style.display = 'flex';
  }

  // Si Google no responde en este lapso (ej. quedó esperando un popup
  // bloqueado por el navegador), se corta en vez de dejar "Conectando…"
  // colgado para siempre.
  function withTimeout(promise, ms, msg) {
    return Promise.race([
      promise,
      new Promise((_, reject) => setTimeout(() => reject(new Error(msg)), ms))
    ]);
  }

  // ── Auth & conexión (Client ID y Sheet ID ya son fijos, nadie los toca) ─────
  // IMPORTANTE: connectSheets() tiene que dispararse siempre desde un toque
  // real del usuario (click/submit), nunca solo al cargar la página — si no,
  // el navegador (sobre todo en celular) bloquea el popup de login de Google
  // en silencio y la conexión queda esperando para siempre.
  async function connectSheets() {
    setLoading(true, 'Conectando con Google Sheets…');
    try {
      await withTimeout(
        SheetsAPI.init(CONFIG.CLIENT_ID, CONFIG.OWN_SHEET_ID, CONFIG.CARGAS_SHEET_ID, CONFIG.CARGAS_TAB, CONFIG.PEDIDOS_TAB),
        20000,
        'Tardó demasiado en responder. Puede que el navegador haya bloqueado la ventana de Google — probá de nuevo.'
      );
      document.getElementById('btn-logout').style.display = 'inline-flex';
      const badge = document.getElementById('user-badge');
      const rol = SheetsAPI.canEdit() ? 'Editor' : 'Solo lectura';
      badge.textContent = `${getDisplayName()} · ${rol}`;
      badge.style.display = 'inline';
      applyPermissions();
      if (!SheetsAPI.canEditDetected()) {
        toast('No se pudo confirmar tu permiso (Editor/Lector) — habilitá la Drive API en Google Cloud Console para que la detección sea exacta. Por ahora se asume Editor.', 'error');
      }
      toast('Conectado a Google Sheets', 'success');
      SheetsAPI.logAccess(getDisplayName());
      if (!localStorage.getItem('palets_sawGuide')) {
        localStorage.setItem('palets_sawGuide', '1');
        showGuide();
      }
      await loadData();
    } catch (e) {
      toast('Error al conectar: ' + errMsg(e), 'error');
      // Dejamos una forma de reintentar con un toque, en vez de una pantalla
      // muerta — reintentar directo acá adentro no sirve porque ya no
      // estaríamos dentro de un gesto del usuario.
      if (getDisplayName()) showReconnect();
    } finally {
      setLoading(false);
    }
  }

  // "Salir" deja el dispositivo listo para que entre otra persona: limpia el
  // nombre y la pista de la última cuenta de Google usada, para no forzar la
  // misma cuenta/nombre en el siguiente login.
  function logout() {
    SheetsAPI.signOut();
    localStorage.removeItem('palets_displayName');
    localStorage.removeItem('palets_lastEmail');
    document.getElementById('btn-logout').style.display = 'none';
    document.getElementById('user-badge').style.display = 'none';
    showWelcome();
    toast('Sesión cerrada');
  }

  // ── Loading ─────────────────────────────────────────────────────────────────
  function setLoading(show, msg = '') {
    const el = document.getElementById('loading-overlay');
    el.style.display = show ? 'flex' : 'none';
    if (msg) el.querySelector('p').textContent = msg;
  }

  // ── Tab navigation ──────────────────────────────────────────────────────────
  function initTabs() {
    document.querySelectorAll('.tab-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
        document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));
        btn.classList.add('active');
        document.getElementById('pane-' + btn.dataset.tab).classList.add('active');
        if (btn.dataset.tab === 'dashboard') renderDashboard();
        if (btn.dataset.tab === 'historial') renderHistorial();
        if (btn.dataset.tab === 'chequeo') renderChequeo();
        if (btn.dataset.tab === 'clientes') renderClientes();
      });
    });
  }

  // ── Form: Devolución ────────────────────────────────────────────────────────
  function initDevolucionForm() {
    document.getElementById('dev-fecha').value = today();

    document.getElementById('qty-minus').addEventListener('click', () => {
      const input = document.getElementById('dev-cantidad');
      input.value = Math.max(1, (parseInt(input.value) || 1) - 1);
    });
    document.getElementById('qty-plus').addEventListener('click', () => {
      const input = document.getElementById('dev-cantidad');
      input.value = (parseInt(input.value) || 0) + 1;
    });

    document.getElementById('form-devolucion').addEventListener('submit', async e => {
      e.preventDefault();
      if (!SheetsAPI.canEdit()) { toast('Tu cuenta tiene acceso de solo lectura, no podés registrar devoluciones', 'error'); return; }
      const cliente = document.getElementById('dev-cliente').value.trim();
      const cantidad = parseInt(document.getElementById('dev-cantidad').value);
      const fecha = document.getElementById('dev-fecha').value;
      if (!cliente) { toast('Ingresá el cliente', 'error'); return; }
      if (!cantidad || cantidad <= 0) { toast('La cantidad debe ser mayor a 0', 'error'); return; }
      if (!fecha) { toast('Ingresá la fecha', 'error'); return; }

      const record = {
        fecha,
        cliente,
        cantidad,
        usuario: getDisplayName() || SheetsAPI.getUserName(),
        observaciones: document.getElementById('dev-obs').value.trim()
      };

      setLoading(true, 'Guardando devolución…');
      try {
        await SheetsAPI.appendDevolucion(record);
        toast(`Devolución guardada: ${cliente} devolvió ${cantidad} palet(s)`, 'success');
        document.getElementById('form-devolucion').reset();
        document.getElementById('dev-fecha').value = today();
        document.getElementById('dev-cantidad').value = 1;
        await loadData();
      } catch (e) {
        toast('Error al guardar: ' + errMsg(e), 'error');
      } finally {
        setLoading(false);
      }
    });
  }

  // ── Permisos (Editor/Lector nativos de Google Drive) ─────────────────────────
  // "Registrar devolución" y "Clientes" (renombrar/excluir) son acciones de
  // edición, se ocultan para quien solo tiene permiso de Lector en la Sheet.
  function applyPermissions() {
    const canEdit = SheetsAPI.canEdit();
    ['registro', 'clientes'].forEach(tabName => {
      const tabBtn = document.querySelector(`.tab-btn[data-tab="${tabName}"]`);
      tabBtn.style.display = canEdit ? '' : 'none';
      if (!canEdit && tabBtn.classList.contains('active')) {
        tabBtn.classList.remove('active');
        document.getElementById('pane-' + tabName).classList.remove('active');
        document.querySelector('.tab-btn[data-tab="dashboard"]').classList.add('active');
        document.getElementById('pane-dashboard').classList.add('active');
      }
    });
  }

  // ── Data loading ────────────────────────────────────────────────────────────
  async function loadData() {
    setLoading(true, 'Cargando datos…');
    try {
      [_cargas, _pedidos, _devoluciones, _clientesConfig] = await Promise.all([
        SheetsAPI.readCargas(),
        SheetsAPI.readPedidos(),
        SheetsAPI.readDevoluciones(),
        SheetsAPI.readClientesConfig()
      ]);
      _saldos = Saldos.calcSaldos(_cargas, _devoluciones, _clientesConfig);
      _chequeo = Saldos.calcChequeo(_cargas, _pedidos, _clientesConfig);
      _clientesEditables = Saldos.buildClientesEditables(_cargas, _pedidos, _clientesConfig);
      populateClientesDatalist();
      populateNombresCanonicosDatalist();
      renderDashboard();
      renderHistorial();
      renderChequeo();
      renderClientes();
    } catch (e) {
      toast('Error al cargar: ' + errMsg(e), 'error');
    } finally {
      setLoading(false);
    }
  }

  function populateClientesDatalist() {
    const datalist = document.getElementById('lista-clientes');
    datalist.innerHTML = '';
    _saldos
      .map(s => s.cliente)
      .sort((a, b) => a.localeCompare(b))
      .forEach(c => {
        const opt = document.createElement('option');
        opt.value = c;
        datalist.appendChild(opt);
      });
  }

  function populateNombresCanonicosDatalist() {
    const datalist = document.getElementById('lista-nombres-canonicos');
    datalist.innerHTML = '';
    Saldos.buildNombresCanonicos(_clientesEditables).forEach(nombre => {
      const opt = document.createElement('option');
      opt.value = nombre;
      datalist.appendChild(opt);
    });
  }

  // ── Dashboard ───────────────────────────────────────────────────────────────
  function renderDashboard() {
    const totales = Saldos.calcTotales(_saldos);
    if (!_saldos.length) {
      document.getElementById('kpi-grid').innerHTML = '<p class="no-data">Sin datos todavía</p>';
      document.getElementById('saldos-table').innerHTML = '<p class="no-data">Sin datos</p>';
      return;
    }

    document.getElementById('kpi-grid').innerHTML = `
      <div class="kpi-card"><span class="kpi-val">${totales.salidos}</span><span class="kpi-label">Palets salidos</span></div>
      <div class="kpi-card"><span class="kpi-val">${totales.devueltos}</span><span class="kpi-label">Palets devueltos</span></div>
      <div class="kpi-card ${totales.saldo > 0 ? 'bad' : 'good'}"><span class="kpi-val">${totales.saldo}</span><span class="kpi-label">Palets pendientes</span></div>
      <div class="kpi-card"><span class="kpi-val">${totales.clientesConDeuda}</span><span class="kpi-label">Clientes con deuda</span></div>
    `;

    renderSaldosTable(document.getElementById('saldos-search').value.trim().toLowerCase());
  }

  function renderSaldosTable(filter = '') {
    const rows = _saldos.filter(s => s.cliente.toLowerCase().includes(filter));
    if (!rows.length) { document.getElementById('saldos-table').innerHTML = '<p class="no-data">Sin resultados</p>'; return; }

    document.getElementById('saldos-table').innerHTML = `
      <table>
        <thead><tr><th>Cliente</th><th>Salidos</th><th>Devueltos</th><th>Saldo</th></tr></thead>
        <tbody>${rows.map(s => `<tr>
          <td>${escapeHtml(s.cliente)}</td>
          <td>${s.salidos}</td>
          <td>${s.devueltos}</td>
          <td><span class="saldo-pill ${s.saldo > 0 ? 'debe' : 'aldia'}">${s.saldo > 0 ? s.saldo + ' debe' : 'Al día'}</span></td>
        </tr>`).join('')}</tbody>
      </table>`;
  }

  // ── Historial ───────────────────────────────────────────────────────────────
  function renderHistorial(filter = '') {
    const rows = _devoluciones
      .filter(d => (d['Cliente'] || '').toLowerCase().includes(filter))
      .slice()
      .reverse();
    if (!rows.length) { document.getElementById('historial-table').innerHTML = '<p class="no-data">Sin devoluciones registradas</p>'; return; }

    document.getElementById('historial-table').innerHTML = `
      <table>
        <thead><tr><th>Fecha</th><th>Cliente</th><th>Cantidad</th><th>Usuario</th><th>Observaciones</th></tr></thead>
        <tbody>${rows.map(d => `<tr>
          <td>${escapeHtml(d['Fecha'])}</td>
          <td>${escapeHtml(d['Cliente'])}</td>
          <td>${escapeHtml(d['Cantidad'])}</td>
          <td>${escapeHtml(d['Usuario'])}</td>
          <td>${escapeHtml(d['Observaciones'])}</td>
        </tr>`).join('')}</tbody>
      </table>`;
  }

  // ── Chequeo: pedidos vs cargados ──────────────────────────────────────────────
  function renderChequeo() {
    if (!_chequeo.length) { document.getElementById('chequeo-table').innerHTML = '<p class="no-data">Sin datos</p>'; return; }

    document.getElementById('chequeo-table').innerHTML = `
      <table>
        <thead><tr><th>Cliente</th><th>Palets pedidos</th><th>Palets cargados</th><th>Diferencia</th></tr></thead>
        <tbody>${_chequeo.map(c => `<tr>
          <td>${escapeHtml(c.cliente)}</td>
          <td>${c.pedidos}</td>
          <td>${c.cargados}</td>
          <td><span class="diff-pill ${c.diferencia === 0 ? 'ok' : 'mismatch'}">${c.diferencia > 0 ? '+' : ''}${c.diferencia}</span></td>
        </tr>`).join('')}</tbody>
      </table>`;
  }

  // ── Clientes: renombrar / excluir ─────────────────────────────────────────────
  // Ordenados por volumen de palets (buildClientesEditables ya los ordena así)
  // para priorizar unificar primero los que más pesan. "Mostrar como" usa un
  // datalist con los nombres canónicos ya en uso, para evitar crear una nueva
  // variante por error en vez de unificar con una existente.
  function renderClientes(filter = '') {
    if (!_clientesEditables.length) { document.getElementById('clientes-table').innerHTML = '<p class="no-data">Sin datos</p>'; return; }

    const rows = _clientesEditables
      .map((c, i) => ({ ...c, idx: i }))
      .filter(c => c.original.toLowerCase().includes(filter));

    if (!rows.length) { document.getElementById('clientes-table').innerHTML = '<p class="no-data">Sin resultados</p>'; return; }

    document.getElementById('clientes-table').innerHTML = `
      <table class="clientes-table">
        <thead><tr><th>Nombre original</th><th>Palets</th><th>Mostrar como</th><th>Excluir</th></tr></thead>
        <tbody>${rows.map(c => `<tr data-idx="${c.idx}">
          <td>${escapeHtml(c.original)}</td>
          <td>${c.palets}</td>
          <td><input type="text" class="cli-mostrar" list="lista-nombres-canonicos" value="${escapeHtml(c.mostrarComo)}" placeholder="${escapeHtml(c.original)}" /></td>
          <td><input type="checkbox" class="cli-excluir" ${c.excluir ? 'checked' : ''} /></td>
        </tr>`).join('')}</tbody>
      </table>`;
  }

  async function guardarClientes() {
    if (!SheetsAPI.canEdit()) { toast('Tu cuenta tiene acceso de solo lectura', 'error'); return; }
    // Partimos de TODAS las filas (no solo las visibles si hay un filtro
    // aplicado) y pisamos con lo editado, para no perder al guardar las
    // filas que el buscador esté ocultando en este momento.
    const list = _clientesEditables.map(c => ({ original: c.original, mostrarComo: c.mostrarComo, excluir: c.excluir }));
    document.querySelectorAll('#clientes-table tbody tr').forEach(tr => {
      const idx = parseInt(tr.dataset.idx, 10);
      list[idx] = {
        original: _clientesEditables[idx].original,
        mostrarComo: tr.querySelector('.cli-mostrar').value.trim(),
        excluir: tr.querySelector('.cli-excluir').checked
      };
    });

    setLoading(true, 'Guardando clientes…');
    try {
      await SheetsAPI.saveClientesConfig(list);
      toast('Cambios guardados', 'success');
      await loadData();
    } catch (e) {
      toast('Error al guardar: ' + errMsg(e), 'error');
    } finally {
      setLoading(false);
    }
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────
  function today() {
    return new Date().toISOString().slice(0, 10);
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str == null ? '' : String(str);
    return div.innerHTML;
  }

  // ── Boot ────────────────────────────────────────────────────────────────────
  function boot() {
    initTabs();
    initDevolucionForm();

    document.getElementById('form-welcome').addEventListener('submit', e => {
      e.preventDefault();
      const nombre = document.getElementById('input-nombre').value.trim();
      const codigo = document.getElementById('input-codigo').value;
      if (!nombre) return;
      if (codigo !== CONFIG.ACCESS_CODE) { toast('Código de acceso incorrecto', 'error'); return; }
      localStorage.setItem('palets_displayName', nombre);
      document.getElementById('modal-welcome').style.display = 'none';
      connectSheets();
    });

    document.getElementById('btn-logout').addEventListener('click', logout);
    document.getElementById('btn-refresh').addEventListener('click', loadData);
    document.getElementById('btn-settings').addEventListener('click', showSettings);
    document.getElementById('btn-guide').addEventListener('click', showGuide);
    document.getElementById('modal-guide-close').addEventListener('click', () => {
      document.getElementById('modal-guide').style.display = 'none';
    });
    document.getElementById('btn-guide-ok').addEventListener('click', () => {
      document.getElementById('modal-guide').style.display = 'none';
    });
    document.getElementById('modal-settings-close').addEventListener('click', () => {
      document.getElementById('modal-settings').style.display = 'none';
    });
    document.getElementById('btn-guardar-nombre').addEventListener('click', () => {
      const nombre = document.getElementById('input-nombre-editar').value.trim();
      if (!nombre) { toast('Ingresá un nombre', 'error'); return; }
      localStorage.setItem('palets_displayName', nombre);
      document.getElementById('modal-settings').style.display = 'none';
      const badge = document.getElementById('user-badge');
      if (badge.style.display !== 'none') {
        const rol = SheetsAPI.canEdit() ? 'Editor' : 'Solo lectura';
        badge.textContent = `${nombre} · ${rol}`;
      }
      toast('Nombre actualizado', 'success');
    });

    document.getElementById('saldos-search').addEventListener('input', e => renderSaldosTable(e.target.value.trim().toLowerCase()));
    document.getElementById('historial-search').addEventListener('input', e => renderHistorial(e.target.value.trim().toLowerCase()));
    document.getElementById('clientes-search').addEventListener('input', e => renderClientes(e.target.value.trim().toLowerCase()));
    document.getElementById('btn-guardar-clientes').addEventListener('click', guardarClientes);

    document.getElementById('btn-reconnect').addEventListener('click', () => {
      document.getElementById('modal-reconnect').style.display = 'none';
      connectSheets();
    });
    document.getElementById('link-no-soy-yo').addEventListener('click', e => {
      e.preventDefault();
      document.getElementById('modal-reconnect').style.display = 'none';
      localStorage.removeItem('palets_displayName');
      localStorage.removeItem('palets_lastEmail');
      showWelcome();
    });

    // No dispara la conexión sola: si ya hay un nombre guardado, pide un
    // toque más (modal "Hola de nuevo") para que el pedido de login a
    // Google salga de un gesto real del usuario y no lo bloquee el navegador.
    if (getDisplayName()) {
      showReconnect();
    } else {
      showWelcome();
    }
  }

  return { boot };
})();

// Wait for gapi + gsi to load, then boot
window.onGapiLoaded = () => { window.gapiReady = true; tryBoot(); };
window.onGsiLoaded = () => { window.gsiReady = true; tryBoot(); };
function tryBoot() {
  if (window.gapiReady && window.gsiReady) App.boot();
}
