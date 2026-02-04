import type { Address, Chain, Hex } from "viem";

export interface Config {
  chain: Chain;
  wNative: Address;
  maxBlockRange?: number;
  options: Options;
}

export interface Options {
  vaultWhitelist: Address[] | "morpho-api";
  additionalMarketsWhitelist: Hex[];
  checkProfit: boolean;
  treasuryAddress?: Address;
  liquidationBufferBps?: number;
  useFlashbots: boolean;
  blockInterval?: number;
}

export type ChainConfig = Omit<Config, "options"> &
  Options & {
    chainId: number;
    rpcUrl: string;
    executorAddress: Address;
    liquidationPrivateKey: Hex;
  };
