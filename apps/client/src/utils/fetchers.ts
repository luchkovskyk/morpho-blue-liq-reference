import type { Account, Address, Chain, Client, Hex, Transport } from "viem";
import { zeroAddress } from "viem";
import {
  AccrualPosition,
  Market,
  MarketParams,
  PreLiquidationParams,
  PreLiquidationPosition,
  getChainAddresses,
} from "@morpho-org/blue-sdk";
import "@morpho-org/blue-sdk-viem/lib/augment";
import { Time } from "@morpho-org/morpho-ts";

import { getLogs, multicall } from "viem/actions";
import { morphoBlueAbi } from "../abis/morpho/morphoBlue";
import { preLiquidationFactoryAbi } from "../abis/morpho/preLiquidationFactory";
import { PreLiquidationContract } from "./types";
import { oracleAbi } from "../abis/morpho/oracle";
import { adaptiveCurveIrmAbi, metaMorphoAbi } from "@morpho-org/blue-sdk-viem";

export async function fetchMarketsForVaults(
  client: Client<Transport, Chain, Account>,
  vaults: Address[],
): Promise<Hex[]> {
  try {
    if (vaults.length === 0) return [];

    // Round 1: get withdrawQueueLength for all vaults in one multicall
    const lengthResults = await multicall(client, {
      contracts: vaults.map((vault) => ({
        address: vault,
        abi: metaMorphoAbi,
        functionName: "withdrawQueueLength" as const,
      })),
      allowFailure: false,
    });

    // Build flat array of withdrawQueue calls
    const queueCalls: {
      address: Address;
      abi: typeof metaMorphoAbi;
      functionName: "withdrawQueue";
      args: [bigint];
    }[] = [];
    for (let v = 0; v < vaults.length; v++) {
      const length = Number(lengthResults[v]);
      for (let i = 0; i < length; i++) {
        queueCalls.push({
          address: vaults[v]!,
          abi: metaMorphoAbi,
          functionName: "withdrawQueue",
          args: [BigInt(i)],
        });
      }
    }

    if (queueCalls.length === 0) return [];

    // Round 2: get all withdrawQueue entries in one multicall
    const queueResults = await multicall(client, {
      contracts: queueCalls,
      allowFailure: false,
    });

    return [...new Set(queueResults as Hex[])];
  } catch (error) {
    console.error(`Error fetching markets for vaults: ${error}`);
    return [];
  }
}

export async function fetchLiquidatablePositions(
  client: Client<Transport, Chain, Account>,
  morphoAddress: Address,
  preLiquidationFactoryAddress: Address | undefined,
  marketIds: Hex[],
): Promise<{
  liquidatablePositions: AccrualPosition[];
  preLiquidatablePositions: PreLiquidationPosition[];
}> {
  try {
    const [borrowersByMarkets, preLiquidationContracts] = await Promise.all([
      getBorrowers(client, morphoAddress, marketIds),
      getPreLiquidationContracts(client, preLiquidationFactoryAddress, marketIds),
    ]);

    const positions = await fetchMarketsAndPositions(client, morphoAddress, borrowersByMarkets);

    const liquidatablePositions = positions.filter(
      (position) => position.seizableCollateral !== undefined && position.seizableCollateral !== 0n,
    );
    const preLiquidatablePositions = await getPreLiquidatablePositions(
      client,
      preLiquidationContracts,
      positions,
      morphoAddress,
    );

    return {
      liquidatablePositions,
      preLiquidatablePositions,
    };
  } catch (error) {
    console.error(`Error fetching liquidatable positions: ${error}`);
    return {
      liquidatablePositions: [],
      preLiquidatablePositions: [],
    };
  }
}

async function fetchMarketsAndPositions(
  client: Client<Transport, Chain, Account>,
  morphoAddress: Address,
  borrowersByMarkets: { marketId: Hex; borrowers: Address[] }[],
): Promise<AccrualPosition[]> {
  const uniqueMarketIds = [...new Set(borrowersByMarkets.map((b) => b.marketId))];

  if (uniqueMarketIds.length === 0) return [];

  // Build all position (market, borrower) pairs
  const positionPairs: { marketId: Hex; borrower: Address }[] = [];
  for (const { marketId, borrowers } of borrowersByMarkets) {
    for (const borrower of borrowers) {
      positionPairs.push({ marketId, borrower });
    }
  }

  // Round 1 multicall: idToMarketParams + market state + all positions
  const round1Contracts = [
    // idToMarketParams for each unique market
    ...uniqueMarketIds.map((id) => ({
      address: morphoAddress,
      abi: morphoBlueAbi,
      functionName: "idToMarketParams" as const,
      args: [id] as const,
    })),
    // market state for each unique market
    ...uniqueMarketIds.map((id) => ({
      address: morphoAddress,
      abi: morphoBlueAbi,
      functionName: "market" as const,
      args: [id] as const,
    })),
    // position for each (market, borrower) pair
    ...positionPairs.map(({ marketId, borrower }) => ({
      address: morphoAddress,
      abi: morphoBlueAbi,
      functionName: "position" as const,
      args: [marketId, borrower] as const,
    })),
  ];

  const round1Results = await multicall(client, {
    contracts: round1Contracts,
    allowFailure: false,
  });

  const numMarkets = uniqueMarketIds.length;

  // Parse idToMarketParams results
  const marketParamsMap = new Map<Hex, MarketParams>();
  for (let i = 0; i < numMarkets; i++) {
    const result = round1Results[i] as [Address, Address, Address, Address, bigint];
    const [loanToken, collateralToken, oracle, irm, lltv] = result;
    const params = new MarketParams({ loanToken, collateralToken, oracle, irm, lltv });
    marketParamsMap.set(uniqueMarketIds[i]!, params);
  }

  // Parse market state results
  const marketStateMap = new Map<
    Hex,
    {
      totalSupplyAssets: bigint;
      totalSupplyShares: bigint;
      totalBorrowAssets: bigint;
      totalBorrowShares: bigint;
      lastUpdate: bigint;
      fee: bigint;
    }
  >();
  for (let i = 0; i < numMarkets; i++) {
    const result = round1Results[numMarkets + i] as [
      bigint,
      bigint,
      bigint,
      bigint,
      bigint,
      bigint,
    ];
    const [
      totalSupplyAssets,
      totalSupplyShares,
      totalBorrowAssets,
      totalBorrowShares,
      lastUpdate,
      fee,
    ] = result;
    marketStateMap.set(uniqueMarketIds[i]!, {
      totalSupplyAssets,
      totalSupplyShares,
      totalBorrowAssets,
      totalBorrowShares,
      lastUpdate,
      fee,
    });
  }

  // Parse position results
  const positionOffset = numMarkets * 2;
  const positionResults: {
    marketId: Hex;
    borrower: Address;
    supplyShares: bigint;
    borrowShares: bigint;
    collateral: bigint;
  }[] = [];
  for (let i = 0; i < positionPairs.length; i++) {
    const result = round1Results[positionOffset + i] as [bigint, bigint, bigint];
    const [supplyShares, borrowShares, collateral] = result;
    positionResults.push({
      marketId: positionPairs[i]!.marketId,
      borrower: positionPairs[i]!.borrower,
      supplyShares,
      borrowShares,
      collateral,
    });
  }

  // Round 2: oracle prices + rateAtTarget
  const chainAddresses = getChainAddresses(client.chain.id);

  // Collect unique oracle addresses (non-zero)
  const uniqueOracles = [
    ...new Set([...marketParamsMap.values()].map((p) => p.oracle).filter((o) => o !== zeroAddress)),
  ];

  // Collect markets that use the adaptive curve IRM
  const adaptiveIrmMarketIds = uniqueMarketIds.filter((id) => {
    const params = marketParamsMap.get(id)!;
    return params.irm.toLowerCase() === chainAddresses.adaptiveCurveIrm.toLowerCase();
  });

  const round2Contracts = [
    // oracle.price() for each unique oracle
    ...uniqueOracles.map((oracle) => ({
      address: oracle,
      abi: oracleAbi,
      functionName: "price" as const,
    })),
    // adaptiveCurveIrm.rateAtTarget(marketId) for adaptive IRM markets
    ...adaptiveIrmMarketIds.map((id) => ({
      address: chainAddresses.adaptiveCurveIrm,
      abi: adaptiveCurveIrmAbi,
      functionName: "rateAtTarget" as const,
      args: [id] as const,
    })),
  ];

  let oraclePriceMap = new Map<Address, bigint | undefined>();
  let rateAtTargetMap = new Map<Hex, bigint>();

  if (round2Contracts.length > 0) {
    const round2Results = await multicall(client, {
      contracts: round2Contracts,
      allowFailure: true,
    });

    // Parse oracle prices
    for (let i = 0; i < uniqueOracles.length; i++) {
      const result = round2Results[i]!;
      if (result.status === "success") {
        oraclePriceMap.set(uniqueOracles[i]!, result.result as bigint);
      } else {
        oraclePriceMap.set(uniqueOracles[i]!, undefined);
      }
    }

    // Parse rateAtTarget results
    for (let i = 0; i < adaptiveIrmMarketIds.length; i++) {
      const result = round2Results[uniqueOracles.length + i]!;
      if (result.status === "success") {
        rateAtTargetMap.set(adaptiveIrmMarketIds[i]!, result.result as bigint);
      }
    }
  }

  // Build Market objects
  const marketMap = new Map<Hex, Market>();
  for (const marketId of uniqueMarketIds) {
    const params = marketParamsMap.get(marketId)!;
    const state = marketStateMap.get(marketId)!;
    const price = params.oracle === zeroAddress ? undefined : oraclePriceMap.get(params.oracle);
    const rateAtTarget = rateAtTargetMap.get(marketId);

    const market = new Market({
      params,
      totalSupplyAssets: state.totalSupplyAssets,
      totalBorrowAssets: state.totalBorrowAssets,
      totalSupplyShares: state.totalSupplyShares,
      totalBorrowShares: state.totalBorrowShares,
      lastUpdate: state.lastUpdate,
      fee: state.fee,
      price,
      rateAtTarget,
    });
    marketMap.set(marketId, market);
  }

  // Build AccrualPosition objects
  const now = Time.timestamp();
  return positionResults.map(({ marketId, borrower, supplyShares, borrowShares, collateral }) => {
    const market = marketMap.get(marketId)!;
    const accrualPosition = new AccrualPosition(
      { user: borrower, supplyShares, borrowShares, collateral },
      market,
    );
    return accrualPosition.accrueInterest(now);
  });
}

async function getBorrowers(
  client: Client<Transport, Chain, Account>,
  morphoAddress: Address,
  marketIds: Hex[],
): Promise<{ marketId: Hex; borrowers: Address[] }[]> {
  try {
    const logs = await getLogs(client, {
      address: morphoAddress,
      event: morphoBlueAbi.find((entry) => entry.type === "event" && entry.name === "Borrow")!,
      fromBlock: 18883124n, // TODO: get chain specific values
    });

    const uniqueBorrowersSet = new Set<{ address: Address; marketId: Hex }>();
    for (const log of logs) {
      if (log.args.onBehalf) {
        uniqueBorrowersSet.add({
          address: log.args.onBehalf as Address,
          marketId: log.args.id as Hex,
        });
      }
    }

    const uniqueBorrowers = Array.from(uniqueBorrowersSet);

    const borrowersByMarkets = marketIds.map((marketId) => {
      const borrowers = uniqueBorrowers
        .filter((borrower) => borrower.marketId === marketId)
        .map((borrower) => borrower.address);
      return {
        marketId: marketId,
        borrowers: borrowers,
      };
    });

    return borrowersByMarkets;
  } catch (error) {
    throw new Error(`Error getting Borrow logs: ${error}`);
  }
}

async function getPreLiquidationContracts(
  client: Client<Transport, Chain, Account>,
  preLiquidationFactoryAddress: Address | undefined,
  marketIds: Hex[],
) {
  try {
    if (!preLiquidationFactoryAddress) return [];
    const logs = await getLogs(client, {
      address: preLiquidationFactoryAddress,
      event: preLiquidationFactoryAbi.find(
        (entry) => entry.type === "event" && entry.name === "CreatePreLiquidation",
      )!,
    });

    return logs
      .filter((log) => marketIds.includes(log.args.id as Hex))
      .map((log) => {
        return {
          marketId: log.args.id as Hex,
          address: log.args.preLiquidation as Address,
          preLiquidationParams: log.args.preLiquidationParams as PreLiquidationParams,
        };
      });
  } catch (error) {
    throw new Error(`Error getting PreLiquidation logs: ${error}`);
  }
}

async function getPreLiquidatablePositions(
  client: Client<Transport, Chain, Account>,
  preLiquidationContracts: PreLiquidationContract[],
  positions: AccrualPosition[],
  morphoAddress: Address,
) {
  try {
    // Find positions that have a matching pre-liquidation contract
    const positionsWithPreLiq = positions
      .map((position) => {
        const preLiquidationContract = preLiquidationContracts.find(
          (contract) => contract.marketId === position.marketId,
        );
        return preLiquidationContract ? { position, preLiquidationContract } : null;
      })
      .filter((entry): entry is NonNullable<typeof entry> => entry !== null);

    if (positionsWithPreLiq.length === 0) return [];

    // Collect unique pre-liquidation oracles that differ from the market oracle
    const oracleCalls: { address: Address; abi: typeof oracleAbi; functionName: "price" }[] = [];
    const uniquePreLiqOracles = new Map<Address, number>(); // oracle address -> index in oracleCalls

    for (let i = 0; i < positionsWithPreLiq.length; i++) {
      const { position, preLiquidationContract } = positionsWithPreLiq[i]!;
      const preLiqOracle = preLiquidationContract.preLiquidationParams.preLiquidationOracle;
      if (
        preLiqOracle !== position.market.params.oracle &&
        !uniquePreLiqOracles.has(preLiqOracle)
      ) {
        uniquePreLiqOracles.set(preLiqOracle, oracleCalls.length);
        oracleCalls.push({
          address: preLiqOracle,
          abi: oracleAbi,
          functionName: "price" as const,
        });
      }
    }

    // Build multicall: isAuthorized calls + oracle price calls
    const authCalls = positionsWithPreLiq.map(({ position, preLiquidationContract }) => ({
      address: morphoAddress,
      abi: morphoBlueAbi,
      functionName: "isAuthorized" as const,
      args: [position.user, preLiquidationContract.address] as const,
    }));

    const allCalls = [...authCalls, ...oracleCalls];

    if (allCalls.length === 0) return [];

    const results = await multicall(client, {
      contracts: allCalls,
      allowFailure: true,
    });

    // Parse oracle prices
    const preLiqOraclePriceMap = new Map<Address, bigint | undefined>();
    const oracleOffset = authCalls.length;
    for (const [oracle, callIdx] of uniquePreLiqOracles) {
      const result = results[oracleOffset + callIdx]!;
      preLiqOraclePriceMap.set(
        oracle,
        result.status === "success" ? (result.result as bigint) : undefined,
      );
    }

    // Build PreLiquidationPosition objects
    const preLiquidatablePositions: PreLiquidationPosition[] = [];
    for (let i = 0; i < positionsWithPreLiq.length; i++) {
      const { position, preLiquidationContract } = positionsWithPreLiq[i]!;
      const authResult = results[i]!;

      if (authResult.status !== "success" || authResult.result === false) continue;

      const preLiqOracle = preLiquidationContract.preLiquidationParams.preLiquidationOracle;
      const preLiquidationOraclePrice =
        preLiqOracle === position.market.params.oracle
          ? position.market.price
          : preLiqOraclePriceMap.get(preLiqOracle);

      const preLiquidatablePosition = new PreLiquidationPosition(
        {
          preLiquidationParams: preLiquidationContract.preLiquidationParams,
          preLiquidation: preLiquidationContract.address,
          preLiquidationOraclePrice,
          ...position,
        },
        position.market,
      );

      const preSeizableCollateral = preLiquidatablePosition.seizableCollateral;
      if (preSeizableCollateral === undefined || preSeizableCollateral === 0n) continue;

      preLiquidatablePositions.push(preLiquidatablePosition);
    }

    return preLiquidatablePositions;
  } catch (error) {
    throw new Error(`Error fetching pre-liquidatable positions: ${error}`);
  }
}
