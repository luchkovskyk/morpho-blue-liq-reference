import { Chain, createWalletClient, Hex, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { createSimpleInvalidation, logsCache, LogsCacheConfig } from "@morpho-org/viem-dlc";
import { createOptimizedNodeFsStore } from "./node-fs-store";

const invalidationStrategy = createSimpleInvalidation();

const getDefaultConfig = (options?: {
  binSize?: number;
  maxBlockRange?: number;
  maxRequestsPerSecond?: number;
}): LogsCacheConfig => ({
  binSize: options?.binSize ?? 10_000,
  invalidationStrategy,
  store: createOptimizedNodeFsStore({
    base: process.env.LOCAL_CACHE_BASE_PATH ?? ".cache",
    maxWritesPerSecond: 50,
  }),
  logsDividerConfig: {
    maxBlockRange: options?.maxBlockRange ?? 10_000,
    maxConcurrentChunks: 5,
  },
  rateLimiterConfig: {
    maxBurstRequests: 20,
    maxRequestsPerSecond: options?.maxRequestsPerSecond ?? 100,
  },
});

export function getClient(chain: Chain, rpcUrl: string, privateKey: Hex, maxBlockRange?: number) {
  const client = createWalletClient({
    chain,
    transport: logsCache(http(rpcUrl), getDefaultConfig({ maxBlockRange })),
    account: privateKeyToAccount(privateKey),
  });

  return client;
}
