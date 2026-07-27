const net = require('net');

function isPortAvailable(port, host = '127.0.0.1') {
  return new Promise(resolve => {
    const server = net.createServer();
    server.unref();
    server.once('error', () => resolve(false));
    server.listen({ port, host, exclusive: true }, () => server.close(() => resolve(true)));
  });
}

function probePort(port, host = '127.0.0.1', timeout = 600) {
  return new Promise(resolve => {
    const socket = net.createConnection({ port, host });
    const done = value => { socket.destroy(); resolve(value); };
    socket.setTimeout(timeout);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

async function allocateAvailablePort(tasks, options = {}) {
  const start = options.start || 4100;
  const end = options.end || 5000;
  const used = new Set(Object.values(tasks || {}).map(task => task.port).filter(Number.isInteger));
  const check = options.isAvailable || isPortAvailable;
  for (let port = start; port < end; port++) {
    if (!used.has(port) && await check(port, options.host)) return port;
  }
  return null;
}

module.exports = { isPortAvailable, probePort, allocateAvailablePort };
