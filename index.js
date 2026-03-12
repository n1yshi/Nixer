if (!process.env.PORT) process.env.PORT = "10422";

import("./src/server.mjs").catch((err) => {
  console.error("Failed to start server:", err);
  process.exitCode = 1;
});

