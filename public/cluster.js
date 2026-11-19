/* ETS2 HUD - Tablero analógico (cliente ES5)
 * Usa el mismo servidor que el HUD original (/ws y /api/state).
 */
(function () {
  'use strict';

  var SVGNS = 'http://www.w3.org/2000/svg';
  var ARC_LEN = 414.69;   // 270° de un círculo r=88
  var CIRC = 552.92;      // circunferencia completa r=88
  var DAYS = ['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom'];
  var POLL_MS = 250;

  function $(id) { return document.getElementById(id); }
  function pad(n) { return n < 10 ? '0' + n : '' + n; }
  function clamp01(x) { return Math.max(0, Math.min(1, x)); }

  var el = {
    speed: $('speed'), units: $('units'), speedArc: $('speedArc'),
    speedNeedle: $('speedNeedle'), speedTicks: $('speedTicks'),
    speedLimitMark: $('speedLimitMark'), speedCcMark: $('speedCcMark'),
    rpm: $('rpm'), rpmArc: $('rpmArc'), rpmNeedle: $('rpmNeedle'), rpmTicks: $('rpmTicks'),
    limit: $('limit'), gear: $('gear'), cc: $('cc'), ccBox: $('ccBox'), clock: $('clock'),
    city: $('city'), company: $('company'), dist: $('dist'), eta: $('eta'),
    deadline: $('deadline'), rest: $('rest'),
    fuelSegs: $('fuelSegs').getElementsByTagName('span'), fuelText: $('fuelText'),
    retText: $('retText'),
    overlay: $('overlay'), overlayText: $('overlayText')
  };

  // ------------------------------------------------------------------
  // Helpers de DOM con caché (solo toca lo que cambió)
  // ------------------------------------------------------------------
  var cache = {};
  function setText(node, key, v) {
    if (cache[key] === v) return; cache[key] = v; node.textContent = v;
  }
  function setClass(node, key, v) {
    if (cache['c' + key] === v) return; cache['c' + key] = v;
    node.setAttribute('class', v); // setAttribute sirve para HTML y SVG
  }
  function setAttr(node, key, name, v) {
    if (cache['a' + key] === v) return; cache['a' + key] = v; node.setAttribute(name, v);
  }

  function angle(pct) { return 135 + 270 * clamp01(pct); }

  // ------------------------------------------------------------------
  // Agujas animadas: el servidor manda datos ~20 veces por segundo y acá
  // las agujas se deslizan hacia el valor nuevo a 60 cuadros por segundo.
  // ------------------------------------------------------------------
  var raf = window.requestAnimationFrame || window.webkitRequestAnimationFrame ||
            function (cb) { return setTimeout(cb, 16); };
  var gauges = {
    s: { arc: el.speedArc, needle: el.speedNeedle, cur: 0, target: 0 },
    r: { arc: el.rpmArc, needle: el.rpmNeedle, cur: 0, target: 0 }
  };
  var animating = false;

  function drawGauge(key, pct) {
    var g = gauges[key];
    setAttr(g.arc, key + 'arc', 'stroke-dasharray', (ARC_LEN * pct).toFixed(1) + ' ' + CIRC);
    setAttr(g.needle, key + 'nd', 'transform', 'rotate(' + angle(pct).toFixed(1) + ' 100 100)');
  }

  function animate() {
    var moving = false;
    for (var key in gauges) {
      var g = gauges[key];
      var diff = g.target - g.cur;
      if (Math.abs(diff) > 0.0008) {
        g.cur += diff * 0.22;   // suavizado: llega al valor en ~150 ms
        moving = true;
      } else {
        g.cur = g.target;
      }
      drawGauge(key, g.cur);
    }
    if (moving) { raf(animate); } else { animating = false; }
  }

  function setGauge(key, pct) {
    gauges[key].target = clamp01(pct);
    if (!animating) { animating = true; raf(animate); }
  }

  // ------------------------------------------------------------------
  // Escalas (se dibujan una vez y se rehacen si cambian unidades o rpm máx.)
  // ------------------------------------------------------------------
  function drawScale(group, max, minorStep, majorStep, labelFn, redFrom) {
    while (group.firstChild) group.removeChild(group.firstChild);
    for (var v = 0; v <= max + 0.001; v += minorStep) {
      var pct = v / max;
      var a = angle(pct) * Math.PI / 180;
      var major = Math.abs(v / majorStep - Math.round(v / majorStep)) < 0.001;
      var r1 = major ? 72 : 78;
      var r2 = 84;
      var line = document.createElementNS(SVGNS, 'line');
      line.setAttribute('x1', (100 + r1 * Math.cos(a)).toFixed(2));
      line.setAttribute('y1', (100 + r1 * Math.sin(a)).toFixed(2));
      line.setAttribute('x2', (100 + r2 * Math.cos(a)).toFixed(2));
      line.setAttribute('y2', (100 + r2 * Math.sin(a)).toFixed(2));
      var cls = 'tick' + (major ? ' major' : '') + (redFrom && v >= redFrom ? ' redzone' : '');
      line.setAttribute('class', cls);
      group.appendChild(line);

      if (major) {
        var t = document.createElementNS(SVGNS, 'text');
        t.setAttribute('x', (100 + 60 * Math.cos(a)).toFixed(2));
        t.setAttribute('y', (100 + 60 * Math.sin(a) + 4).toFixed(2));
        t.setAttribute('class', 'tick-label');
        t.textContent = labelFn(v);
        group.appendChild(t);
      }
    }
  }

  var speedMax = 0, rpmMaxScale = 0;

  function ensureScales(s) {
    var sMax = s.units === 'mph' ? 80 : 120;
    if (sMax !== speedMax) {
      speedMax = sMax;
      var maj = s.units === 'mph' ? 10 : 20;
      drawScale(el.speedTicks, sMax, maj / 2, maj, function (v) { return '' + v; }, 0);
    }
    var rMax = Math.max(2500, Math.ceil(s.rpmMax / 500) * 500);
    if (rMax !== rpmMaxScale) {
      rpmMaxScale = rMax;
      drawScale(el.rpmTicks, rMax, 250, 500, function (v) { return '' + v / 100; }, rMax * 0.85);
    }
  }

  // ------------------------------------------------------------------
  // Formatos
  // ------------------------------------------------------------------
  function gameClock(min) {
    var day = Math.floor(min / 1440) % 7;
    return DAYS[day] + ' ' + pad(Math.floor((min % 1440) / 60)) + ':' + pad(Math.floor(min % 60));
  }
  function duration(min) {
    min = Math.max(0, Math.round(min));
    var h = Math.floor(min / 60), m = min % 60;
    return h > 0 ? h + 'h ' + pad(m) : m + 'm';
  }
  function gearLabel(g) { return g === 0 ? 'N' : (g < 0 ? 'R' + (-g) : '' + g); }

  // ------------------------------------------------------------------
  // Render
  // ------------------------------------------------------------------
  var lampBase = {};
  var blink = { l: false, r: false, changedAt: 0 };
  function lamp(id, on) {
    var node = $(id);
    if (!lampBase[id]) lampBase[id] = node.className;
    setClass(node, id, lampBase[id] + (on ? ' on' : ''));
  }

  function render(s) {
    if (!s || !s.connected) {
      setText(el.overlayText, 'ov', 'Esperando al juego…');
      setClass(el.overlay, 'ov', 'overlay');
      return;
    }
    setClass(el.overlay, 'ov', 'overlay hidden');
    ensureScales(s);

    // velocidad
    var over = s.limit > 0 && s.speed > s.limit + 2;
    setText(el.speed, 'speed', '' + s.speed);
    setText(el.units, 'units', s.units);
    setClass(el.speed, 'speed', 'value' + (over ? ' over' : ''));
    setClass(el.speedArc, 'sarc', 'arc' + (over ? ' over' : ''));
    setGauge('s', (s.speedF != null ? s.speedF : s.speed) / speedMax);

    if (s.limit > 0) {
      setAttr(el.speedLimitMark, 'lm', 'transform', 'rotate(' + angle(s.limit / speedMax).toFixed(1) + ' 100 100)');
      setClass(el.speedLimitMark, 'lm', 'mark limit-mark');
      setText(el.limit, 'limit', '' + s.limit);
      setClass(el.limit, 'limit', 'limit');
    } else {
      setClass(el.speedLimitMark, 'lm', 'mark limit-mark hidden');
      setClass(el.limit, 'limit', 'limit hidden');
    }

    if (s.cc > 0) {
      setAttr(el.speedCcMark, 'ccm', 'transform', 'rotate(' + angle(s.cc / speedMax).toFixed(1) + ' 100 100)');
      setClass(el.speedCcMark, 'ccm', 'mark cc-mark');
      setText(el.cc, 'cc', '' + s.cc);
      setClass(el.ccBox, 'cc', 'cc');
    } else {
      setClass(el.speedCcMark, 'ccm', 'mark cc-mark hidden');
      setClass(el.ccBox, 'cc', 'cc hidden');
    }

    // rpm: verde en la zona económica, rojo arriba del 85%
    var rpmPct = s.rpm / rpmMaxScale;
    var rpmZone = rpmPct > 0.85 ? ' red' : (rpmPct >= 0.4 && rpmPct <= 0.7 ? ' green' : '');
    setText(el.rpm, 'rpm', '' + Math.round(s.rpm / 100));
    setClass(el.rpmArc, 'rarc', 'arc rpm' + rpmZone);
    setGauge('r', rpmPct);

    // centro
    setText(el.gear, 'gear', gearLabel(s.gear));
    setText(el.clock, 'clock', gameClock(s.time));

    // tira de ruta
    if (s.onJob) {
      setText(el.city, 'city', s.city || '—');
      setText(el.company, 'company', s.company + (s.cargo ? ' · ' + s.cargo : ''));
      var left = s.deadline - s.time;
      setText(el.deadline, 'dl', left >= 0 ? duration(left) : '-' + duration(-left));
      setClass(el.deadline, 'dl', 'big' + (left < 0 ? ' late' : (left < 120 ? ' warn' : '')));
    } else {
      // Sin trabajo según el juego (p. ej. rutas del DLC Coaches, que el plugin
      // no informa como trabajo): si hay ruta en el GPS, lo mostramos igual.
      setText(el.city, 'city', s.routeDist > 0 ? 'Ruta en GPS' : 'Sin trabajo');
      setText(el.company, 'company', '');
      setText(el.deadline, 'dl', '--');
      setClass(el.deadline, 'dl', 'big');
    }
    setText(el.dist, 'dist', s.routeDist > 0 ? s.routeDist + ' ' + s.distUnit : '--');
    setText(el.eta, 'eta', s.routeDist > 0 ? duration(s.routeTime / 60) : '--');

    setText(el.rest, 'rest', s.rest > 0 ? duration(s.rest) : '¡YA!');
    setClass(el.rest, 'rest', 'big' + (s.rest <= 0 ? ' late' : (s.rest <= 60 ? ' warn' : '')));

    // Combustible en 10 segmentos, como el tablero del juego
    var fuelPct = s.fuelCap ? clamp01(s.fuel / s.fuelCap) : 0;
    var lit = Math.ceil(fuelPct * 10 - 0.001);
    var segColor = s.warn.fuel ? ' low' : (lit <= 3 ? ' mid' : '');
    for (var i = 0; i < el.fuelSegs.length; i++) {
      setClass(el.fuelSegs[i], 'seg' + i, 'seg' + (i < lit ? ' on' + segColor : ''));
    }
    setText(el.fuelText, 'ft', s.fuel + ' L · ' + s.range + ' ' + s.distUnit);

    // testigos
    var L = s.lights || {}, W = s.warn || {};
    // left/right son el estado real de la lámpara (titila), también con balizas.
    // Respaldo: si hay balizas pero las luces no cambian hace >1.2 s, titilamos acá.
    var now = new Date().getTime();
    if (L.left !== blink.l || L.right !== blink.r) {
      blink.l = L.left; blink.r = L.right; blink.changedAt = now;
    }
    var synth = L.hazard && now - blink.changedAt > 1200;
    var phase = Math.floor(now / 400) % 2 === 0;
    var leftOn = synth ? phase : L.left;
    var rightOn = synth ? phase : L.right;
    lamp('i-left', leftOn);
    lamp('i-right', rightOn);
    lamp('i-low', L.low);
    lamp('i-high', L.high);
    lamp('i-beacon', L.beacon);
    lamp('i-hazard', L.hazard); // fijo mientras estén puestas; titilan solo las flechas
    lamp('i-park', L.parkBrake);
    lamp('i-brake', L.brake);
    lamp('i-motor', L.motorBrake);
    lamp('i-ret', L.retarder > 0);
    setText(el.retText, 'ret', L.retarder > 0 ? 'R' + L.retarder : 'R');
    lamp('i-diff', L.diffLock);
    lamp('i-lift', L.liftAxle);
    lamp('i-trailer', L.trailer);
    lamp('i-wipers', L.wipers);
    lamp('w-fuel', W.fuel);
    lamp('w-adblue', W.adblue);
    lamp('w-air', W.air);
    lamp('w-oil', W.oil);
    lamp('w-water', W.water);
    lamp('w-battery', W.battery);
  }


  // ------------------------------------------------------------------
  // Diagnóstico: abrir con ?debug para ver datos/s, cuadros/s y conexión
  // ------------------------------------------------------------------
  var DEBUG = /[?&]debug/.test(location.search);
  var dbg = { msgs: 0, frames: 0, mode: '---', box: null };
  if (DEBUG) {
    dbg.box = document.createElement('div');
    dbg.box.style.cssText = 'position:absolute;left:1vw;bottom:21vh;font:2.4vh monospace;' +
      'color:#0f0;background:#000;padding:0.5vh 1vw;z-index:9';
    document.getElementById('cluster').appendChild(dbg.box);
    (function countFrames() { dbg.frames++; raf(countFrames); })();
    setInterval(function () {
      dbg.box.textContent = dbg.mode + ' | ' + dbg.msgs + ' datos/s | ' + dbg.frames + ' fps';
      dbg.msgs = 0; dbg.frames = 0;
    }, 1000);
  }

  // Si llegan varios mensajes juntos, pintamos solo el último y una vez por frame
  var pending = null, scheduled = false;
  function handleMessage(text) {
    if (DEBUG) dbg.msgs++;
    pending = text;
    if (scheduled) return;
    scheduled = true;
    raf(function () {
      scheduled = false;
      var data;
      try { data = JSON.parse(pending); } catch (e) { return; }
      render(data);
    });
  }

  function offline() {
    setText(el.overlayText, 'ov', 'Sin conexión con la PC. Reintentando…');
    setClass(el.overlay, 'ov', 'overlay');
  }

  // ------------------------------------------------------------------
  // Conexión: WebSocket con fallback a polling
  // ------------------------------------------------------------------
  var wsFailures = 0, polling = false;

  function connectWS() {
    if (!window.WebSocket || wsFailures >= 3) { startPolling(); return; }
    var opened = false, ws;
    try { ws = new WebSocket('ws://' + location.host + '/ws'); }
    catch (e) { wsFailures++; setTimeout(connectWS, 1000); return; }
    ws.onopen = function () { opened = true; wsFailures = 0; dbg.mode = 'WebSocket'; };
    ws.onmessage = function (ev) { handleMessage(ev.data); };
    ws.onclose = function () {
      if (!opened) wsFailures++;
      offline();
      setTimeout(connectWS, 2000);
    };
  }

  function startPolling() {
    if (polling) return;
    polling = true;
    dbg.mode = 'Polling';
    (function tick() {
      var xhr = new XMLHttpRequest();
      xhr.open('GET', '/api/state?t=' + new Date().getTime(), true);
      xhr.timeout = 2000;
      xhr.onreadystatechange = function () {
        if (xhr.readyState !== 4) return;
        if (xhr.status === 200) { handleMessage(xhr.responseText); setTimeout(tick, POLL_MS); }
        else { offline(); setTimeout(tick, 2000); }
      };
      xhr.send();
    })();
  }

  // Pantalla completa al tocar
  document.addEventListener('click', function () {
    var d = document.documentElement;
    var req = d.requestFullscreen || d.webkitRequestFullscreen || d.webkitRequestFullScreen;
    if (req && !(document.fullscreenElement || document.webkitFullscreenElement)) {
      try { req.call(d); } catch (e) { /* no soportado */ }
    }
  }, false);

  // Service worker (necesario para "Instalar app"). Solo registra si el navegador lo permite.
  if ('serviceWorker' in navigator) {
    try { navigator.serviceWorker.register('/sw.js')['catch'](function () {}); } catch (e) { /* sin soporte */ }
  }

  connectWS();
})();
