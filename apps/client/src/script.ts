import * as Sentry from "@sentry/node";

import { chainConfigs, chainConfig } from "@morpho-blue-liquidation-bot/config";

import { startHealthServer } from "./health";

import { launchBot } from ".";

// Initialize Sentry as early as possible
Sentry.init({
  dsn: process.env.SENTRY_DSN,
  environment: process.env.NODE_ENV || "development",
  sampleRate: 1,
  tracesSampleRate: 0,
  debug: process.env.NODE_ENV === "development",
  integrations: [
    // Automatically instrument Node.js libraries and frameworks
    Sentry.httpIntegration(),
    Sentry.consoleLoggingIntegration({ levels: ["info"] }),
  ],
  enableLogs: true,
});

// Capture unhandled promise rejections
process.on("unhandledRejection", (reason, promise) => {
  Sentry.captureException(reason, {
    contexts: {
      unhandledRejection: {
        promise: promise.toString(),
      },
    },
  });
});

// Capture uncaught exceptions
process.on("uncaughtException", (error) => {
  Sentry.captureException(error);
  // Re-throw to maintain default behavior
  throw error;
});

async function run() {
  const configs = Object.keys(chainConfigs)
    .map((config) => {
      try {
        return chainConfig(Number(config));
      } catch {
        return undefined;
      }
    })
    .filter((config) => config !== undefined);

  try {
    // Start health server
    await startHealthServer();

    // biome-ignore lint/complexity/noForEach: <explanation>
    configs.forEach((config) => {
      launchBot(config);
    });
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}

void run();
