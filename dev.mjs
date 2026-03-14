import { spawn } from 'child_process';
import { createConnection } from 'net';

// Start backend server
const server = spawn('npx', ['tsx', 'watch', 'src/server/index.ts'], {
  stdio: 'inherit',
  shell: true,
});

// Wait for server to be ready, then start Vite
function waitForServer(port, cb) {
  const tryConnect = () => {
    const socket = createConnection({ port }, () => {
      socket.destroy();
      cb();
    });
    socket.on('error', () => {
      setTimeout(tryConnect, 500);
    });
  };
  tryConnect();
}

console.log('Waiting for backend server...');
waitForServer(3000, () => {
  console.log('Backend ready! Starting Vite...');
  const vite = spawn('npx', ['vite'], {
    stdio: 'inherit',
    shell: true,
  });

  vite.on('close', (code) => {
    server.kill();
    process.exit(code);
  });
});

process.on('SIGINT', () => {
  server.kill();
  process.exit();
});
