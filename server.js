// ETS2 HUD - servidor
// Lee la telemetria del juego (scs-sdk-plugin) y la manda a la tablet.
//   node server.js          -> modo real (con el juego)
//   node server.js --demo   -> datos simulados (para probar sin jugar)

'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { WebSocketServer } = require('ws');

const PORT = Number(process.env.PORT) || 8080;
const HZ = Number(process.env.HZ) || 20; // actualizaciones por segundo a la tablet
const DEMO = process.argv.includes('--demo');
const PUBLIC_DIR = path.join(__dirname, 'public');

// ---------------------------------------------------------------------------
// Fuente de datos
// ---------------------------------------------------------------------------

let getRaw;
let flashSeenAt = 0; // última vez que se vieron las altas encendidas

if (DEMO) {
  getRaw = createDemoSource();
  console.log('[HUD] Modo DEMO: datos simulados');
} else {
  const { truckSimTelemetry } = require('trucksim-telemetry');
  // OJO: no pasarle opciones a truckSimTelemetry(); si se le pasa un objeto,
  // deja de usar la memoria compartida por defecto y no lee nada del juego.
  const telemetry = truckSimTelemetry();

  // Revisamos las altas a 60 Hz para no perder el destello (dura muy poco
  // y puede caer entre dos envíos a la tablet).
  setInterval(() => {
    if (telemetry.data.current.lightsBeamHigh) flashSeenAt = Date.now();
  }, 1000 / 60);
  telemetry.on('connected', () => console.log('[HUD] Juego conectado'));
  telemetry.on('disconnected', () => console.log('[HUD] Juego desconectado'));
  getRaw = () => telemetry.data.current;
}

// Convierte los datos crudos del SDK en un objeto chico y listo para mostrar.
// (Ojo: algunos campos del SDK son BigInt y no se pueden pasar a JSON, por eso
// elegimos a mano lo que mandamos.)
function snapshot(d) {
  const ats = d.game === 2;
  const speedFactor = ats ? 2.23694 : 3.6; // m/s -> mph o km/h
  const distFactor = ats ? 0.621371 : 1;   // km -> mi o km

  return {
    connected: !!d.sdkActive,
    paused: !!d.paused,
    units: ats ? 'mph' : 'km/h',
    distUnit: ats ? 'mi' : 'km',

    speed: Math.round(Math.abs(d.speed) * speedFactor),
    speedF: Math.round(Math.abs(d.speed) * speedFactor * 10) / 10, // con decimal, para la aguja
    limit: Math.round(d.speedLimit * speedFactor),
    cc: d.cruiseControl ? Math.round(d.cruiseControlSpeed * speedFactor) : 0,
    gear: d.gearDashboard,
    rpm: Math.round(d.engineRpm),
    rpmMax: Math.round(d.engineRpmMax) || 2500,

    fuel: Math.round(d.fuel),
    fuelCap: Math.round(d.fuelCapacity),
    range: Math.round(d.fuelRange * distFactor),

    time: d.timeAbs,                        // minutos de juego
    deadline: d.timeAbsDelivery,            // minutos de juego
    rest: d.restStop,                       // minutos hasta el descanso

    onJob: !!d.onJob,
    cargo: d.cargo || '',
    city: d.cityDst || '',
    company: d.compDst || '',
    routeDist: Math.round((d.routeDistance / 1000) * distFactor * 10) / 10,
    routeTime: Math.round(d.routeTime),     // segundos

    wear: Math.round(Math.max(
      d.wearEngine, d.wearTransmission, d.wearCabin, d.wearChassis, d.wearWheels
    ) * 100),
    cargoDamage: Math.round((d.cargoDamage || 0) * 100),

    lights: {
      left: !!d.blinkerLeftOn,
      right: !!d.blinkerRightOn,
      low: !!d.lightsBeamLow,
      high: !!d.lightsBeamHigh || Date.now() - flashSeenAt < 250, // incluye el destello
      hazard: !!d.lightsHazard,
      beacon: !!d.lightsBeacon,
      parkBrake: !!d.parkBrake,
      motorBrake: !!d.motorBrake,
      wipers: !!d.wipers,
      engine: !!d.engineEnabled,
      brake: !!d.lightsBrake,
      retarder: d.retarderBrake || 0,
      retarderMax: d.retarderStepCount || 0,
      diffLock: !!d.differentialLock,
      liftAxle: !!d.liftAxleIndicator || !!d.trailerLiftAxleIndicator,
      trailer: Array.isArray(d.trailers) && d.trailers.some((t) => t && t.attached),
      cruise: !!d.cruiseControl
    },
    warn: {
      fuel: !!d.fuelWarning,
      air: !!d.airPressureWarning || !!d.airPressureEmergency,
      oil: !!d.oilPressureWarning,
      water: !!d.waterTemperatureWarning,
      battery: !!d.batteryVoltageWarning,
      adblue: !!d.adblueWarning
    }
  };
}

function currentState() {
  try {
    return snapshot(getRaw());
  } catch (err) {
    return { connected: false, error: String(err.message || err) };
  }
}

// ---------------------------------------------------------------------------
// HTTP: archivos estaticos + /api/state (fallback por polling)
// ---------------------------------------------------------------------------

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml'
};

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];

  if (url === '/api/state') {
    res.writeHead(200, {
      'Content-Type': MIME['.json'],
      'Cache-Control': 'no-store'
    });
    res.end(JSON.stringify(currentState()));
    return;
  }

  const file = path.normalize(path.join(PUBLIC_DIR, url === '/' ? 'cluster.html' : url));
  if (!file.startsWith(PUBLIC_DIR)) {
    res.writeHead(403); res.end(); return;
  }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); res.end('No encontrado'); return; }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-cache'
    });
    res.end(buf);
  });
});

// ---------------------------------------------------------------------------
// WebSocket: empuja el estado HZ veces por segundo
// ---------------------------------------------------------------------------

const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws, req) => {
  console.log('[HUD] Tablet conectada:', req.socket.remoteAddress);
  ws.send(JSON.stringify(currentState()));
});

let lastPayload = '';
setInterval(() => {
  if (wss.clients.size === 0) return;
  const payload = JSON.stringify(currentState());
  if (payload === lastPayload) return; // no mandar si no cambio nada
  lastPayload = payload;
  for (const client of wss.clients) {
    if (client.readyState === 1) client.send(payload);
  }
}, 1000 / HZ);

server.listen(PORT, '0.0.0.0', () => {
  console.log('');
  console.log('  ETS2 HUD corriendo. Abri en la tablet:');
  for (const { ip, name } of lanIPs()) {
    console.log('    http://' + ip + ':' + PORT + '   (' + name + ')');
  }
  console.log('');
});

// Placas de red virtuales (VirtualBox, Hyper-V/WSL, VMware, VPNs...) que la tablet no puede alcanzar
const VIRTUAL_NIC = /virtual|vethernet|vmware|vbox|hyper-v|wsl|loopback|bluetooth|tailscale|zerotier|hamachi|radmin|vpn/i;

function lanIPs() {
  const all = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const i of list || []) {
      if (i.family === 'IPv4' && !i.internal) all.push({ ip: i.address, name });
    }
  }
  const real = all.filter((n) => !VIRTUAL_NIC.test(n.name));
  const out = real.length ? real : all; // si filtramos todo, mostramos todo
  return out.length ? out : [{ ip: 'localhost', name: 'local' }];
}

// ---------------------------------------------------------------------------
// Modo demo: un camion imaginario que anda por la ruta
// ---------------------------------------------------------------------------

function createDemoSource() {
  const start = Date.now();
  let gameMinutes = 3 * 1440 + 14 * 60 + 25; // jueves 14:25
  let fuel = 640;
  let dist = 412000;

  setInterval(() => {
    gameMinutes += 0.25; // el tiempo de juego corre mas rapido
    fuel = Math.max(0, fuel - 0.02);
    dist = Math.max(0, dist - 25);
  }, 1000 / 60 * 4);

  return () => {
    const t = (Date.now() - start) / 1000;
    const speedKmh = 72 + Math.sin(t / 6) * 18;
    const gear = Math.max(1, Math.min(12, Math.round(speedKmh / 8)));
    const blink = Math.floor(t * 2) % 2 === 0;
    const turning = Math.floor(t / 10) % 3 === 1;

    return {
      sdkActive: true, paused: false, game: 1,
      speed: speedKmh / 3.6,
      speedLimit: 80 / 3.6,
      cruiseControl: Math.floor(t / 15) % 2 === 0,
      cruiseControlSpeed: 85 / 3.6,
      gearDashboard: gear,
      engineRpm: 1100 + Math.abs(Math.sin(t)) * 600,
      engineRpmMax: 2500,
      fuel, fuelCapacity: 800, fuelRange: fuel / 0.33,
      fuelWarning: fuel < 120,
      timeAbs: Math.floor(gameMinutes),
      timeAbsDelivery: 4 * 1440 + 9 * 60,
      restStop: Math.max(0, 300 - Math.floor(gameMinutes - (3 * 1440 + 14 * 60))),
      onJob: true,
      cargo: 'Maquinaria agrícola',
      cityDst: 'Berlín',
      compDst: 'Tradeaux',
      routeDistance: dist,
      routeTime: dist / 20,
      wearEngine: 0.03, wearTransmission: 0.02, wearCabin: 0.07,
      wearChassis: 0.04, wearWheels: 0.05, cargoDamage: 0.01,
      blinkerLeftOn: turning && blink,
      blinkerRightOn: false,
      lightsBeamLow: true, lightsBeamHigh: false, lightsHazard: false,
      lightsBeacon: Math.floor(t / 12) % 4 === 3,
      parkBrake: false,
      motorBrake: Math.sin(t / 6) < -0.6,
      lightsBrake: Math.sin(t / 6) < -0.8,
      retarderBrake: Math.sin(t / 6) < -0.6 ? 2 : 0, retarderStepCount: 4,
      differentialLock: false, liftAxleIndicator: false,
      trailers: [{ attached: true }],
      wipers: Math.floor(t / 20) % 2 === 1, engineEnabled: true,
      airPressureWarning: false, airPressureEmergency: false,
      oilPressureWarning: false, waterTemperatureWarning: false,
      batteryVoltageWarning: false, adblueWarning: false
    };
  };
}
