import { createContainer } from './bootstrap';
import { createApp } from './app';
import { getConfig } from './config';

async function main() {
  const config = getConfig();
  const container = createContainer(config);
  const app = createApp(config, container);
  await app.listen({ host: config.host, port: config.port });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
