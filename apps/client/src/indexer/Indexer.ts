import type { Account, Address, Chain, Client, Hex, Transport } from "viem";
import { zeroAddress } from "viem";
import { getBlockNumber, getLogs, multicall } from "viem/actions";
import {
  AccrualPosition,
  Market,
  MarketParams,
  PreLiquidationPosition,
  getChainAddresses,
} from "@morpho-org/blue-sdk";
import { adaptiveCurveIrmAbi, metaMorphoAbi } from "@morpho-org/blue-sdk-viem";
import { Time } from "@morpho-org/morpho-ts";

import { oracleAbi } from "../abis/morpho/oracle";
import {
  createEmptyState,
  cloneState,
  positionKey,
  authorizationKey,
  type IndexerState,
  type IndexedMarketState,
} from "./state";
import { syncRange, type SyncConfig } from "./sync";
import { CheckpointManager } from "./checkpoint";

const MAX_RETRIES = 5;
const INITIAL_BACKOFF_MS = 1000;

export class Indexer {
  private client: Client<Transport, Chain, Account>;
  private state: IndexerState;
  private lastSyncedBlock: bigint;
  private checkpoint: CheckpointManager;
  private chainId: number;
  private startBlock: bigint;
  private maxBlockRange: bigint;
  private morphoAddress: Address;
  private adaptiveCurveIrmAddress: Address;
  private preLiquidationFactoryAddress: Address | undefined;
  private vaultAddresses: Address[];
  private trackedVaults: Set<string>;
  private isSyncing = false;
  private logTag: string;

  constructor(options: {
    chainId: number;
    client: Client<Transport, Chain, Account>;
    startBlock: bigint;
    maxBlockRange?: number;
    vaultAddresses: Address[];
    logTag?: string;
  }) {
    this.chainId = options.chainId;
    this.client = options.client;
    this.startBlock = options.startBlock;
    this.maxBlockRange = BigInt(options.maxBlockRange ?? 10_000);
    this.vaultAddresses = options.vaultAddresses;
    this.trackedVaults = new Set(options.vaultAddresses.map((v) => v.toLowerCase()));
    this.logTag = options.logTag ?? `[indexer-${options.chainId}]: `;

    const chainAddresses = getChainAddresses(options.chainId);
    this.morphoAddress = chainAddresses.morpho;
    this.adaptiveCurveIrmAddress = chainAddresses.adaptiveCurveIrm;
    this.preLiquidationFactoryAddress = chainAddresses.preLiquidationFactory;

    this.state = createEmptyState();
    this.lastSyncedBlock = options.startBlock - 1n;
    this.checkpoint = new CheckpointManager(options.chainId);
  }

  async init(): Promise<void> {
    const saved = await this.checkpoint.load();
    if (saved) {
      this.state = saved.state;
      this.lastSyncedBlock = saved.lastSyncedBlock;
      console.log(`${this.logTag}Loaded checkpoint at block ${this.lastSyncedBlock}`);
    } else {
      console.log(`${this.logTag}No checkpoint found, syncing from block ${this.startBlock}`);
      this.lastSyncedBlock = this.startBlock - 1n;
    }

    await this.sync();
  }

  async sync(): Promise<void> {
    if (this.isSyncing) return;
    this.isSyncing = true;
    try {
      await this.syncWithRetry();
    } finally {
      this.isSyncing = false;
    }
  }

  private async syncWithRetry(): Promise<void> {
    const latestBlock = await getBlockNumber(this.client);
    if (latestBlock <= this.lastSyncedBlock) return;

    const startFrom = this.lastSyncedBlock + 1n;

    // Process in chunks of maxBlockRange to respect RPC limits
    let chunkFrom = startFrom;
    while (chunkFrom <= latestBlock) {
      const chunkTo =
        chunkFrom + this.maxBlockRange - 1n < latestBlock
          ? chunkFrom + this.maxBlockRange - 1n
          : latestBlock;

      await this.syncChunkWithRetry(chunkFrom, chunkTo);
      chunkFrom = chunkTo + 1n;
    }
  }

  private async syncChunkWithRetry(fromBlock: bigint, toBlock: bigint): Promise<void> {
    let retries = 0;
    while (retries <= MAX_RETRIES) {
      try {
        // Clone state for transactional sync
        const stateCopy = cloneState(this.state);

        await syncRange(this.getSyncConfig(), stateCopy, fromBlock, toBlock);

        // Success: swap in new state and checkpoint
        this.state = stateCopy;
        this.lastSyncedBlock = toBlock;

        await this.checkpoint.save(this.state, this.lastSyncedBlock, this.chainId);
        return;
      } catch (error) {
        retries++;
        if (retries > MAX_RETRIES) {
          console.error(
            `${this.logTag}Sync chunk ${fromBlock}->${toBlock} failed after ${MAX_RETRIES} retries:`,
            error,
          );
          throw error;
        }
        const backoff = INITIAL_BACKOFF_MS * Math.pow(2, retries - 1);
        console.warn(
          `${this.logTag}Sync chunk ${fromBlock}->${toBlock} error (retry ${retries}/${MAX_RETRIES}, backoff ${backoff}ms):`,
          (error as Error).message,
        );
        await new Promise((resolve) => setTimeout(resolve, backoff));
      }
    }
  }

  private getSyncConfig(): SyncConfig {
    return {
      client: this.client,
      morphoAddress: this.morphoAddress,
      adaptiveCurveIrmAddress: this.adaptiveCurveIrmAddress,
      preLiquidationFactoryAddress: this.preLiquidationFactoryAddress,
      vaultAddresses: this.vaultAddresses,
    };
  }

  updateVaultAddresses(vaults: Address[]): void {
    const newVaults = vaults.filter((v) => !this.trackedVaults.has(v.toLowerCase()));

    this.vaultAddresses = vaults;
    for (const v of vaults) {
      this.trackedVaults.add(v.toLowerCase());
    }

    // Sync SetWithdrawQueue for newly discovered vaults from startBlock
    if (newVaults.length > 0) {
      void this.syncNewVaults(newVaults);
    }
  }

  private async syncNewVaults(newVaults: Address[]): Promise<void> {
    const setWithdrawQueueEvent = metaMorphoAbi.find(
      (e) => e.type === "event" && e.name === "SetWithdrawQueue",
    )!;

    try {
      const results = await Promise.all(
        newVaults.map((vault) =>
          getLogs(this.client, {
            address: vault,
            event: setWithdrawQueueEvent as any,
            fromBlock: this.startBlock,
          }).then((logs) => ({ vault, logs })),
        ),
      );

      for (const { vault, logs } of results) {
        // Apply only the latest SetWithdrawQueue for each vault
        if (logs.length > 0) {
          const lastLog = logs[logs.length - 1]!;
          const newQueue = (lastLog as any).args.newWithdrawQueue as Hex[];
          this.state.vaultWithdrawQueues.set(vault.toLowerCase() as Address, newQueue);
        }
      }

      console.log(`${this.logTag}Synced withdraw queues for ${newVaults.length} new vaults`);
    } catch (error) {
      console.warn(`${this.logTag}Failed to sync new vault withdraw queues:`, error);
    }
  }

  async getLiquidatablePositions(coveredMarketIds: Hex[]): Promise<{
    liquidatablePositions: AccrualPosition[];
    preLiquidatablePositions: PreLiquidationPosition[];
  }> {
    const coveredMarketSet = new Set(coveredMarketIds);

    // Collect markets and positions with borrowShares > 0 in covered markets
    const marketStates = new Map<Hex, IndexedMarketState>();
    const positionPairs: {
      marketId: Hex;
      user: Address;
      supplyShares: bigint;
      borrowShares: bigint;
      collateral: bigint;
    }[] = [];

    for (const [key, pos] of this.state.positions) {
      if (pos.borrowShares === 0n) continue;

      const separatorIndex = key.indexOf("-", 3); // skip "0x" prefix
      const marketId = key.slice(0, separatorIndex) as Hex;
      const user = key.slice(separatorIndex + 1) as Address;

      if (!coveredMarketSet.has(marketId)) continue;

      const marketState = this.state.markets.get(marketId);
      if (!marketState) continue;

      marketStates.set(marketId, marketState);
      positionPairs.push({
        marketId,
        user,
        supplyShares: pos.supplyShares,
        borrowShares: pos.borrowShares,
        collateral: pos.collateral,
      });
    }

    if (positionPairs.length === 0) {
      return { liquidatablePositions: [], preLiquidatablePositions: [] };
    }

    // Fetch oracle prices (the only RPC call we need)
    const uniqueOracles = [
      ...new Set(
        [...marketStates.values()].map((m) => m.params.oracle).filter((o) => o !== zeroAddress),
      ),
    ];

    const oraclePriceMap = new Map<Address, bigint | undefined>();

    if (uniqueOracles.length > 0) {
      const results = await multicall(this.client, {
        contracts: uniqueOracles.map((oracle) => ({
          address: oracle,
          abi: oracleAbi,
          functionName: "price" as const,
        })),
        allowFailure: true,
      });

      for (let i = 0; i < uniqueOracles.length; i++) {
        const r = results[i]!;
        oraclePriceMap.set(
          uniqueOracles[i]!,
          r.status === "success" ? (r.result as bigint) : undefined,
        );
      }
    }

    // Build SDK Market objects from indexed state + oracle prices
    const sdkMarketMap = new Map<Hex, Market>();
    for (const [id, ms] of marketStates) {
      const params = new MarketParams(ms.params);
      const price =
        ms.params.oracle === zeroAddress ? undefined : oraclePriceMap.get(ms.params.oracle);

      sdkMarketMap.set(
        id,
        new Market({
          params,
          totalSupplyAssets: ms.totalSupplyAssets,
          totalBorrowAssets: ms.totalBorrowAssets,
          totalSupplyShares: ms.totalSupplyShares,
          totalBorrowShares: ms.totalBorrowShares,
          lastUpdate: ms.lastUpdate,
          fee: ms.fee,
          price,
          rateAtTarget: ms.rateAtTarget,
        }),
      );
    }

    // Build AccrualPosition objects with interest accrued to now
    const now = Time.timestamp();
    const allPositions = positionPairs.map(
      ({ marketId, user, supplyShares, borrowShares, collateral }) => {
        const market = sdkMarketMap.get(marketId)!;
        const accrualPos = new AccrualPosition(
          { user, supplyShares, borrowShares, collateral },
          market,
        );
        return accrualPos.accrueInterest(now);
      },
    );

    const liquidatablePositions = allPositions.filter(
      (p) => p.seizableCollateral !== undefined && p.seizableCollateral !== 0n,
    );

    // Handle pre-liquidation
    const preLiqContracts = this.state.preLiquidationContracts.filter((c) =>
      coveredMarketSet.has(c.marketId),
    );

    const preLiquidatablePositions = await this.getPreLiquidatablePositions(
      preLiqContracts,
      allPositions,
    );

    return { liquidatablePositions, preLiquidatablePositions };
  }

  private async getPreLiquidatablePositions(
    preLiqContracts: typeof this.state.preLiquidationContracts,
    positions: AccrualPosition[],
  ): Promise<PreLiquidationPosition[]> {
    // Find positions that have a matching pre-liquidation contract and are authorized
    const positionsWithPreLiq = positions
      .map((position) => {
        const contract = preLiqContracts.find((c) => c.marketId === position.marketId);
        if (!contract) return null;

        // Check authorization from indexed state (no RPC needed)
        const isAuthorized =
          this.state.authorizations.get(authorizationKey(position.user, contract.address)) ?? false;
        if (!isAuthorized) return null;

        return { position, contract };
      })
      .filter((e): e is NonNullable<typeof e> => e !== null);

    if (positionsWithPreLiq.length === 0) return [];

    // Collect unique pre-liq oracles that differ from the market oracle
    const uniquePreLiqOracles = new Map<Address, number>();
    const oracleCalls: Address[] = [];

    for (const { position, contract } of positionsWithPreLiq) {
      const preLiqOracle = contract.preLiquidationParams.preLiquidationOracle;
      if (
        preLiqOracle !== position.market.params.oracle &&
        !uniquePreLiqOracles.has(preLiqOracle)
      ) {
        uniquePreLiqOracles.set(preLiqOracle, oracleCalls.length);
        oracleCalls.push(preLiqOracle);
      }
    }

    // Fetch pre-liq oracle prices
    const preLiqOraclePriceMap = new Map<Address, bigint | undefined>();
    if (oracleCalls.length > 0) {
      const results = await multicall(this.client, {
        contracts: oracleCalls.map((oracle) => ({
          address: oracle,
          abi: oracleAbi,
          functionName: "price" as const,
        })),
        allowFailure: true,
      });
      for (const [oracle, idx] of uniquePreLiqOracles) {
        const r = results[idx]!;
        preLiqOraclePriceMap.set(oracle, r.status === "success" ? (r.result as bigint) : undefined);
      }
    }

    // Build PreLiquidationPosition objects
    const result: PreLiquidationPosition[] = [];
    for (const { position, contract } of positionsWithPreLiq) {
      const preLiqOracle = contract.preLiquidationParams.preLiquidationOracle;
      const preLiquidationOraclePrice =
        preLiqOracle === position.market.params.oracle
          ? position.market.price
          : preLiqOraclePriceMap.get(preLiqOracle);

      const preLiqPos = new PreLiquidationPosition(
        {
          preLiquidationParams: contract.preLiquidationParams,
          preLiquidation: contract.address,
          preLiquidationOraclePrice: preLiquidationOraclePrice,
          ...position,
        },
        position.market,
      );

      if (preLiqPos.seizableCollateral !== undefined && preLiqPos.seizableCollateral !== 0n) {
        result.push(preLiqPos);
      }
    }

    return result;
  }

  getMarketsForVaults(vaults: Address[]): Hex[] {
    const marketIds = new Set<Hex>();
    for (const vault of vaults) {
      const queue = this.state.vaultWithdrawQueues.get(vault.toLowerCase() as Address);
      if (queue) {
        for (const id of queue) marketIds.add(id);
      }
    }
    return [...marketIds];
  }
}
