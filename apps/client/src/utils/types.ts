import type { AccrualPosition, IMarket, PreLiquidationParams, PreLiquidationPosition } from "@morpho-org/blue-sdk";
import type { Address, Chain, Hex } from "viem";

export interface ToConvert {
  src: Address;
  dst: Address;
  srcAmount: bigint;
}

export interface ChainConfig {
  chain: Chain;
  rpcUrl: string;
  vaultWhitelist: Address[];
  executorAddress: Address;
  liquidationPrivateKey: Hex;
}

export interface PreLiquidationContract {
  marketId: Hex;
  address: Address;
  preLiquidationParams: PreLiquidationParams;
}

export interface IndexerAPIResponse {
  market: IMarket;
  positionsLiq: AccrualPosition[];
  positionsPreLiq: PreLiquidationPosition[];
}