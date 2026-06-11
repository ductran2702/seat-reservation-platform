import { createApp } from "./app.js";
import { env } from "./env.js";

const app = createApp();

app.listen(env.port, () => {
  console.log(`auth-svc listening on http://localhost:${env.port}`);
});
