import type { Address, Hex } from "viem";

export interface IndexedMarketParams {
  loanToken: Address;
  collateralToken: Address;
  oracle: Address;
  irm: Address;
  lltv: bigint;
}

export interface IndexedMarketState {
  params: IndexedMarketParams;
  totalSupplyAssets: bigint;
  totalSupplyShares: bigint;
  totalBorrowAssets: bigint;
  totalBorrowShares: bigint;
  lastUpdate: bigint;
  fee: bigint;
  rateAtTarget: bigint | undefined;
}

export interface IndexedPositionState {
  supplyShares: bigint;
  borrowShares: bigint;
  collateral: bigint;
}

export interface IndexedPreLiquidationContract {
  marketId: Hex;
  address: Address;
  preLiquidationParams: {
    preLltv: bigint;
    preLCF1: bigint;
    preLCF2: bigint;
    preLIF1: bigint;
    preLIF2: bigint;
    preLiquidationOracle: Address;
  };
}

export interface IndexerState {
  markets: Map<Hex, IndexedMarketState>;
  positions: Map<string, IndexedPositionState>;
  authorizations: Map<string, boolean>;
  preLiquidationContracts: IndexedPreLiquidationContract[];
  vaultWithdrawQueues: Map<Address, Hex[]>;
}

export function positionKey(marketId: Hex, user: Address): string {
  return `${marketId}-${user.toLowerCase()}`;
}

export function authorizationKey(authorizer: Address, authorizee: Address): string {
  return `${authorizer.toLowerCase()}-${authorizee.toLowerCase()}`;
}

export function createEmptyState(): IndexerState {
  return {
    markets: new Map(),
    positions: new Map(),
    authorizations: new Map(),
    preLiquidationContracts: [],
    vaultWithdrawQueues: new Map(),
  };
}

export function cloneState(state: IndexerState): IndexerState {
  return {
    markets: new Map(
      Array.from(state.markets.entries()).map(([k, v]) => [k, { ...v, params: { ...v.params } }]),
    ),
    positions: new Map(
      Array.from(state.positions.entries()).map(([k, v]) => [k, { ...v }]),
    ),
    authorizations: new Map(state.authorizations),
    preLiquidationContracts: state.preLiquidationContracts.map((c) => ({
      ...c,
      preLiquidationParams: { ...c.preLiquidationParams },
    })),
    vaultWithdrawQueues: new Map(
      Array.from(state.vaultWithdrawQueues.entries()).map(([k, v]) => [k, [...v]]),
    ),
  };
}

// Checkpoint serialization

export const CHECKPOINT_VERSION = 1;

export interface CheckpointData {
  version: number;
  chainId: number;
  lastSyncedBlock: string;
  timestamp: number;
  markets: [Hex, SerializedMarketState][];
  positions: [string, SerializedPositionState][];
  authorizations: [string, boolean][];
  preLiquidationContracts: SerializedPreLiquidationContract[];
  vaultWithdrawQueues: [string, Hex[]][];
}

interface SerializedMarketState {
  params: {
    loanToken: Address;
    collateralToken: Address;
    oracle: Address;
    irm: Address;
    lltv: string;
  };
  totalSupplyAssets: string;
  totalSupplyShares: string;
  totalBorrowAssets: string;
  totalBorrowShares: string;
  lastUpdate: string;
  fee: string;
  rateAtTarget: string | null;
}

interface SerializedPositionState {
  supplyShares: string;
  borrowShares: string;
  collateral: string;
}

interface SerializedPreLiquidationContract {
  marketId: Hex;
  address: Address;
  preLiquidationParams: {
    preLltv: string;
    preLCF1: string;
    preLCF2: string;
    preLIF1: string;
    preLIF2: string;
    preLiquidationOracle: Address;
  };
}

export function serializeState(
  state: IndexerState,
  lastSyncedBlock: bigint,
  chainId: number,
): CheckpointData {
  return {
    version: CHECKPOINT_VERSION,
    chainId,
    lastSyncedBlock: lastSyncedBlock.toString(),
    timestamp: Date.now(),
    markets: Array.from(state.markets.entries()).map(([id, m]) => [
      id,
      {
        params: {
          loanToken: m.params.loanToken,
          collateralToken: m.params.collateralToken,
          oracle: m.params.oracle,
          irm: m.params.irm,
          lltv: m.params.lltv.toString(),
        },
        totalSupplyAssets: m.totalSupplyAssets.toString(),
        totalSupplyShares: m.totalSupplyShares.toString(),
        totalBorrowAssets: m.totalBorrowAssets.toString(),
        totalBorrowShares: m.totalBorrowShares.toString(),
        lastUpdate: m.lastUpdate.toString(),
        fee: m.fee.toString(),
        rateAtTarget: m.rateAtTarget !== undefined ? m.rateAtTarget.toString() : null,
      },
    ]),
    positions: Array.from(state.positions.entries()).map(([key, p]) => [
      key,
      {
        supplyShares: p.supplyShares.toString(),
        borrowShares: p.borrowShares.toString(),
        collateral: p.collateral.toString(),
      },
    ]),
    authorizations: Array.from(state.authorizations.entries()),
    preLiquidationContracts: state.preLiquidationContracts.map((c) => ({
      marketId: c.marketId,
      address: c.address,
      preLiquidationParams: {
        preLltv: c.preLiquidationParams.preLltv.toString(),
        preLCF1: c.preLiquidationParams.preLCF1.toString(),
        preLCF2: c.preLiquidationParams.preLCF2.toString(),
        preLIF1: c.preLiquidationParams.preLIF1.toString(),
        preLIF2: c.preLiquidationParams.preLIF2.toString(),
        preLiquidationOracle: c.preLiquidationParams.preLiquidationOracle,
      },
    })),
    vaultWithdrawQueues: Array.from(state.vaultWithdrawQueues.entries()),
  };
}

export function deserializeState(data: CheckpointData): {
  state: IndexerState;
  lastSyncedBlock: bigint;
} {
  const state: IndexerState = {
    markets: new Map(
      data.markets.map(([id, m]) => [
        id,
        {
          params: {
            loanToken: m.params.loanToken,
            collateralToken: m.params.collateralToken,
            oracle: m.params.oracle,
            irm: m.params.irm,
            lltv: BigInt(m.params.lltv),
          },
          totalSupplyAssets: BigInt(m.totalSupplyAssets),
          totalSupplyShares: BigInt(m.totalSupplyShares),
          totalBorrowAssets: BigInt(m.totalBorrowAssets),
          totalBorrowShares: BigInt(m.totalBorrowShares),
          lastUpdate: BigInt(m.lastUpdate),
          fee: BigInt(m.fee),
          rateAtTarget: m.rateAtTarget !== null ? BigInt(m.rateAtTarget) : undefined,
        },
      ]),
    ),
    positions: new Map(
      data.positions.map(([key, p]) => [
        key,
        {
          supplyShares: BigInt(p.supplyShares),
          borrowShares: BigInt(p.borrowShares),
          collateral: BigInt(p.collateral),
        },
      ]),
    ),
    authorizations: new Map(data.authorizations),
    preLiquidationContracts: data.preLiquidationContracts.map((c) => ({
      marketId: c.marketId,
      address: c.address,
      preLiquidationParams: {
        preLltv: BigInt(c.preLiquidationParams.preLltv),
        preLCF1: BigInt(c.preLiquidationParams.preLCF1),
        preLCF2: BigInt(c.preLiquidationParams.preLCF2),
        preLIF1: BigInt(c.preLiquidationParams.preLIF1),
        preLIF2: BigInt(c.preLiquidationParams.preLIF2),
        preLiquidationOracle: c.preLiquidationParams.preLiquidationOracle,
      },
    })),
    vaultWithdrawQueues: new Map(
      data.vaultWithdrawQueues.map(([k, v]) => [k as Address, v]),
    ),
  };

  return { state, lastSyncedBlock: BigInt(data.lastSyncedBlock) };
}
