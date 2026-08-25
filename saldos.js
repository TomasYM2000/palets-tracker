// saldos.js — normalización de clientes, saldos de palets y chequeo Pedidos vs Cargas
const Saldos = (() => {
  // ── Config de clientes (unificar nombres / excluir no-clientes) ──────────────
  function normKey(s) {
    return (s || '').toString().trim().toLowerCase();
  }

  function buildConfigMap(clientesConfig) {
    const map = new Map();
    (clientesConfig || []).forEach(c => map.set(normKey(c.original), c));
    return map;
  }

  // Devuelve el nombre canónico a usar, o null si la fila debe excluirse.
  function resolveCliente(raw, configMap) {
    const entry = configMap.get(normKey(raw));
    if (entry && entry.excluir) return null;
    if (entry && entry.mostrarComo) return entry.mostrarComo;
    return (raw || '').toString().trim();
  }

  // Junta, para la pantalla de edición, todos los nombres crudos vistos en
  // Cargas/Pedidos con lo que ya haya configurado, sin perder configuraciones
  // de clientes que ya no aparezcan en las hojas (por si vuelven a aparecer).
  // Suma los palets de Cargas por nombre crudo para poder priorizar: conviene
  // unificar primero los nombres que más volumen mueven.
  function buildClientesEditables(cargas, pedidos, clientesConfig) {
    const vistos = new Map();
    const palets = new Map();
    cargas.forEach(c => {
      if (!c.cliente) return;
      const key = normKey(c.cliente);
      vistos.set(key, c.cliente);
      palets.set(key, (palets.get(key) || 0) + c.palets);
    });
    pedidos.forEach(p => { if (p.cliente) vistos.set(normKey(p.cliente), p.cliente); });
    const configMap = buildConfigMap(clientesConfig);
    configMap.forEach((v, k) => { if (!vistos.has(k)) vistos.set(k, v.original); });

    return Array.from(vistos.entries())
      .map(([key, original]) => {
        const cfg = configMap.get(key);
        return {
          original,
          mostrarComo: (cfg && cfg.mostrarComo) || '',
          excluir: !!(cfg && cfg.excluir),
          palets: palets.get(key) || 0
        };
      })
      .sort((a, b) => b.palets - a.palets || a.original.localeCompare(b.original));
  }

  // Nombres canónicos ya en uso (para el autocomplete de "Mostrar como"):
  // cada mostrarComo configurado, más los originales que no están mapeados
  // ni excluidos (esos ya funcionan como su propio nombre canónico).
  function buildNombresCanonicos(clientesEditables) {
    const nombres = new Set();
    clientesEditables.forEach(c => {
      if (c.excluir) return;
      nombres.add(c.mostrarComo || c.original);
    });
    return Array.from(nombres).sort((a, b) => a.localeCompare(b));
  }

  // ── Saldos por cliente (Cargas − Devoluciones) ────────────────────────────────
  function calcSaldos(cargas, devoluciones, clientesConfig) {
    const configMap = buildConfigMap(clientesConfig);
    const porCliente = {};

    cargas.forEach(c => {
      const nombre = resolveCliente(c.cliente, configMap);
      if (!nombre) return; // excluido
      if (!porCliente[nombre]) porCliente[nombre] = { cliente: nombre, salidos: 0, devueltos: 0 };
      porCliente[nombre].salidos += c.palets;
    });

    devoluciones.forEach(d => {
      const raw = (d['Cliente'] || '').trim();
      if (!raw) return;
      const nombre = resolveCliente(raw, configMap);
      if (!nombre) return;
      if (!porCliente[nombre]) porCliente[nombre] = { cliente: nombre, salidos: 0, devueltos: 0 };
      porCliente[nombre].devueltos += parseFloat(d['Cantidad']) || 0;
    });

    return Object.values(porCliente)
      .map(c => ({ ...c, saldo: parseFloat((c.salidos - c.devueltos).toFixed(2)) }))
      .sort((a, b) => b.saldo - a.saldo);
  }

  function calcTotales(saldos) {
    return saldos.reduce((acc, s) => ({
      salidos: acc.salidos + s.salidos,
      devueltos: acc.devueltos + s.devueltos,
      saldo: acc.saldo + s.saldo,
      clientesConDeuda: acc.clientesConDeuda + (s.saldo > 0 ? 1 : 0)
    }), { salidos: 0, devueltos: 0, saldo: 0, clientesConDeuda: 0 });
  }

  // ── Chequeo: palets pedidos (texto libre en Observaciones) vs cargados ───────
  // "8 Palets" → 8. "Sueltos" o sin número → 0. Es un parseo best-effort del
  // texto que ya cargan en Pedidos, no reemplaza tener un dato limpio.
  function parsePaletsDeTexto(texto) {
    const m = (texto || '').toString().match(/(\d+)\s*palet/i);
    return m ? parseInt(m[1], 10) : 0;
  }

  function calcChequeo(cargas, pedidos, clientesConfig) {
    const configMap = buildConfigMap(clientesConfig);
    const porCliente = {};

    pedidos.forEach(p => {
      const nombre = resolveCliente(p.cliente, configMap);
      if (!nombre) return;
      if (!porCliente[nombre]) porCliente[nombre] = { cliente: nombre, pedidos: 0, cargados: 0 };
      porCliente[nombre].pedidos += parsePaletsDeTexto(p.observaciones);
    });

    cargas.forEach(c => {
      const nombre = resolveCliente(c.cliente, configMap);
      if (!nombre) return;
      if (!porCliente[nombre]) porCliente[nombre] = { cliente: nombre, pedidos: 0, cargados: 0 };
      porCliente[nombre].cargados += c.palets;
    });

    return Object.values(porCliente)
      .map(c => ({ ...c, diferencia: parseFloat((c.cargados - c.pedidos).toFixed(2)) }))
      .filter(c => c.pedidos > 0 || c.cargados > 0)
      .sort((a, b) => Math.abs(b.diferencia) - Math.abs(a.diferencia));
  }

  return { calcSaldos, calcTotales, calcChequeo, buildClientesEditables, buildNombresCanonicos, parsePaletsDeTexto };
})();
