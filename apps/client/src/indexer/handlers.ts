import type { Address, Hex } from "viem";

import type { IndexerState, IndexedPositionState } from "./state";
import { positionKey, authorizationKey } from "./state";

// Decoded log shape from viem getLogs with ABI
interface DecodedLog {
  args: Record<string, unknown>;
  eventName?: string;
  blockNumber: bigint;
  logIndex: number;
}

function getOrCreatePosition(state: IndexerState, key: string): IndexedPositionState {
  let pos = state.positions.get(key);
  if (!pos) {
    pos = { supplyShares: 0n, borrowShares: 0n, collateral: 0n };
    state.positions.set(key, pos);
  }
  return pos;
}

// ---- Morpho Blue event handlers ----

export function handleCreateMarket(
  state: IndexerState,
  log: DecodedLog,
  blockTimestamp: bigint,
): void {
  const id = log.args.id as Hex;
  const mp = log.args.marketParams as {
    loanToken: Address;
    collateralToken: Address;
    oracle: Address;
    irm: Address;
    lltv: bigint;
  };
  state.markets.set(id, {
    params: {
      loanToken: mp.loanToken,
      collateralToken: mp.collateralToken,
      oracle: mp.oracle,
      irm: mp.irm,
      lltv: mp.lltv,
    },
    totalSupplyAssets: 0n,
    totalSupplyShares: 0n,
    totalBorrowAssets: 0n,
    totalBorrowShares: 0n,
    lastUpdate: blockTimestamp,
    fee: 0n,
    rateAtTarget: undefined,
  });
}

export function handleSetFee(state: IndexerState, log: DecodedLog, blockTimestamp: bigint): void {
  const id = log.args.id as Hex;
  const market = state.markets.get(id);
  if (!market) return;
  market.fee = log.args.newFee as bigint;
  market.lastUpdate = blockTimestamp;
}

export function handleAccrueInterest(
  state: IndexerState,
  log: DecodedLog,
  blockTimestamp: bigint,
): void {
  const id = log.args.id as Hex;
  const market = state.markets.get(id);
  if (!market) return;
  const interest = log.args.interest as bigint;
  const feeShares = log.args.feeShares as bigint;
  market.totalSupplyAssets += interest;
  market.totalBorrowAssets += interest;
  market.totalSupplyShares += feeShares;
  market.lastUpdate = blockTimestamp;
}

export function handleSupply(state: IndexerState, log: DecodedLog, blockTimestamp: bigint): void {
  const id = log.args.id as Hex;
  const market = state.markets.get(id);
  if (!market) return;
  const assets = log.args.assets as bigint;
  const shares = log.args.shares as bigint;
  market.totalSupplyAssets += assets;
  market.totalSupplyShares += shares;
  market.lastUpdate = blockTimestamp;

  const user = log.args.onBehalf as Address;
  const pos = getOrCreatePosition(state, positionKey(id, user));
  pos.supplyShares += shares;
}

export function handleWithdraw(
  state: IndexerState,
  log: DecodedLog,
  blockTimestamp: bigint,
): void {
  const id = log.args.id as Hex;
  const market = state.markets.get(id);
  if (!market) return;
  const assets = log.args.assets as bigint;
  const shares = log.args.shares as bigint;
  market.totalSupplyAssets -= assets;
  market.totalSupplyShares -= shares;
  market.lastUpdate = blockTimestamp;

  const user = log.args.onBehalf as Address;
  const pos = state.positions.get(positionKey(id, user));
  if (pos) pos.supplyShares -= shares;
}

export function handleBorrow(state: IndexerState, log: DecodedLog, blockTimestamp: bigint): void {
  const id = log.args.id as Hex;
  const market = state.markets.get(id);
  if (!market) return;
  const assets = log.args.assets as bigint;
  const shares = log.args.shares as bigint;
  market.totalBorrowAssets += assets;
  market.totalBorrowShares += shares;
  market.lastUpdate = blockTimestamp;

  const user = log.args.onBehalf as Address;
  const pos = getOrCreatePosition(state, positionKey(id, user));
  pos.borrowShares += shares;
}

export function handleRepay(state: IndexerState, log: DecodedLog, blockTimestamp: bigint): void {
  const id = log.args.id as Hex;
  const market = state.markets.get(id);
  if (!market) return;
  const assets = log.args.assets as bigint;
  const shares = log.args.shares as bigint;
  market.totalBorrowAssets -= assets;
  market.totalBorrowShares -= shares;
  market.lastUpdate = blockTimestamp;

  const user = log.args.onBehalf as Address;
  const pos = state.positions.get(positionKey(id, user));
  if (pos) pos.borrowShares -= shares;
}

export function handleSupplyCollateral(state: IndexerState, log: DecodedLog): void {
  const id = log.args.id as Hex;
  const user = log.args.onBehalf as Address;
  const assets = log.args.assets as bigint;
  const pos = getOrCreatePosition(state, positionKey(id, user));
  pos.collateral += assets;
}

export function handleWithdrawCollateral(state: IndexerState, log: DecodedLog): void {
  const id = log.args.id as Hex;
  const user = log.args.onBehalf as Address;
  const assets = log.args.assets as bigint;
  const pos = state.positions.get(positionKey(id, user));
  if (pos) pos.collateral -= assets;
}

export function handleLiquidate(
  state: IndexerState,
  log: DecodedLog,
  blockTimestamp: bigint,
): void {
  const id = log.args.id as Hex;
  const market = state.markets.get(id);
  if (!market) return;

  const repaidAssets = log.args.repaidAssets as bigint;
  const repaidShares = log.args.repaidShares as bigint;
  const seizedAssets = log.args.seizedAssets as bigint;
  const badDebtAssets = log.args.badDebtAssets as bigint;
  const badDebtShares = log.args.badDebtShares as bigint;

  market.totalBorrowAssets -= repaidAssets;
  market.totalBorrowShares -= repaidShares;
  market.totalSupplyAssets -= badDebtAssets;
  market.totalSupplyShares -= badDebtShares;
  market.lastUpdate = blockTimestamp;

  const borrower = log.args.borrower as Address;
  const pos = state.positions.get(positionKey(id, borrower));
  if (pos) {
    pos.collateral -= seizedAssets;
    pos.borrowShares -= repaidShares + badDebtShares;
  }
}

export function handleSetAuthorization(state: IndexerState, log: DecodedLog): void {
  const authorizer = log.args.authorizer as Address;
  const authorized = log.args.authorized as Address;
  const isAuth = log.args.newIsAuthorized as boolean;
  state.authorizations.set(authorizationKey(authorizer, authorized), isAuth);
}

// ---- AdaptiveCurveIRM event handler ----

export function handleBorrowRateUpdate(state: IndexerState, log: DecodedLog): void {
  const id = log.args.id as Hex;
  const rateAtTarget = log.args.rateAtTarget as bigint;
  const market = state.markets.get(id);
  if (market) market.rateAtTarget = rateAtTarget;
}

// ---- PreLiquidation Factory event handler ----

export function handleCreatePreLiquidation(state: IndexerState, log: DecodedLog): void {
  const preLiquidationParams = log.args.preLiquidationParams as {
    preLltv: bigint;
    preLCF1: bigint;
    preLCF2: bigint;
    preLIF1: bigint;
    preLIF2: bigint;
    preLiquidationOracle: Address;
  };

  state.preLiquidationContracts.push({
    marketId: log.args.id as Hex,
    address: log.args.preLiquidation as Address,
    preLiquidationParams,
  });
}

// ---- MetaMorpho event handler ----

export function handleSetWithdrawQueue(
  state: IndexerState,
  log: DecodedLog,
  vaultAddress: Address,
): void {
  const newQueue = log.args.newWithdrawQueue as Hex[];
  state.vaultWithdrawQueues.set(vaultAddress.toLowerCase() as Address, newQueue);
}

// ---- Dispatch ----

type MorphoHandler = (state: IndexerState, log: DecodedLog, blockTimestamp: bigint) => void;

const MORPHO_HANDLERS: Record<string, MorphoHandler> = {
  CreateMarket: handleCreateMarket,
  SetFee: handleSetFee,
  AccrueInterest: handleAccrueInterest,
  Supply: handleSupply,
  Withdraw: handleWithdraw,
  Borrow: handleBorrow,
  Repay: handleRepay,
  SupplyCollateral: (state, log) => handleSupplyCollateral(state, log),
  WithdrawCollateral: (state, log) => handleWithdrawCollateral(state, log),
  Liquidate: handleLiquidate,
  SetAuthorization: (state, log) => handleSetAuthorization(state, log),
};

export function getMorphoHandler(eventName: string): MorphoHandler | undefined {
  return MORPHO_HANDLERS[eventName];
}
