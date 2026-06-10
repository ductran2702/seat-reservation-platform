import { createApp } from "./app.js";
import { env } from "./lib/env.js";

const app = createApp();

app.listen(env.port, () => {
  console.log(`API listening on http://localhost:${env.port}`);
});
