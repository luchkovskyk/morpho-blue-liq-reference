import type { Account, Address, Chain, Client, Hex, Transport } from "viem";
import {
  AccrualPosition,
  MarketId,
  PreLiquidationParams,
  PreLiquidationPosition,
} from "@morpho-org/blue-sdk";
import "@morpho-org/blue-sdk-viem/lib/augment";
import { Time } from "@morpho-org/morpho-ts";

import { getLogs, readContract } from "viem/actions";
import { morphoBlueAbi } from "../abis/morpho/morphoBlue";
import { preLiquidationFactoryAbi } from "../abis/morpho/preLiquidationFactory";
import { PreLiquidationContract } from "./types";
import { oracleAbi } from "../abis/morpho/oracle";
import { metaMorphoAbi } from "@morpho-org/blue-sdk-viem";

export async function fetchMarketsForVaults(
  client: Client<Transport, Chain, Account>,
  vaults: Address[],
): Promise<Hex[]> {
  try {
    const vaultV1Markets = await Promise.all(
      vaults.map(async (vault) => fetchVaultV1Markets(client, vault)),
    );

    return [...new Set(vaultV1Markets.flat())];
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

    // TODO: these are fetched successfully, but the other fetches below (which do `eth_call`)
    // are failing -- I think because they're not multicall'ed correctly.
    console.log(borrowersByMarkets, preLiquidationContracts);
    return {
      liquidatablePositions: [],
      preLiquidatablePositions: [],
    };

    const positions = (
      await Promise.all(
        borrowersByMarkets.map(async (borrowersByMarket) => {
          return getPositionsForMarket(
            client,
            borrowersByMarket.marketId,
            borrowersByMarket.borrowers,
          );
        }),
      )
    ).flat();

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
      liquidatablePositions: liquidatablePositions,
      preLiquidatablePositions: preLiquidatablePositions,
    };
  } catch (error) {
    console.error(`Error fetching liquidatable positions: ${error}`);
    return {
      liquidatablePositions: [],
      preLiquidatablePositions: [],
    };
  }
}

async function fetchVaultV1Markets(
  client: Client<Transport, Chain, Account>,
  vaultAddress: Address,
): Promise<Hex[]> {
  try {
    const withdrawQueueLength = await readContract(client, {
      address: vaultAddress,
      abi: metaMorphoAbi,
      functionName: "withdrawQueueLength",
    });

    const indices = Array.from({ length: Number(withdrawQueueLength) }, (_, i) => BigInt(i));

    return await Promise.all(
      indices.map(async (index) => {
        const marketId = await readContract(client, {
          address: vaultAddress,
          abi: metaMorphoAbi,
          functionName: "withdrawQueue",
          args: [index],
        });
        return marketId as Hex;
      }),
    );
  } catch (error) {
    console.error(`Error fetching vault v1 markets: ${error}`);
    return [];
  }
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

async function getPositionsForMarket(
  client: Client<Transport, Chain, Account>,
  marketId: Hex,
  borrowers: Address[],
) {
  try {
    const positions = await Promise.all(
      borrowers.map(async (borrower) =>
        AccrualPosition.fetch(borrower, marketId as MarketId, client),
      ),
    );

    return positions.map((position) => position.accrueInterest(Time.timestamp()));
  } catch (error) {
    throw new Error(`Error fetching positions data for market ${marketId}: ${error}`);
  }
}

async function getPreLiquidatablePositions(
  client: Client<Transport, Chain, Account>,
  preLiquidationContracts: PreLiquidationContract[],
  positions: AccrualPosition[],
  morphoAddress: Address,
) {
  try {
    const preLiquidatablePositions = await Promise.all(
      positions.map(async (position) => {
        const preLiquidationContract = preLiquidationContracts.find(
          (contract) => contract.marketId === position.marketId,
        );

        if (!preLiquidationContract) return null;

        const [preLiquidationOraclePrice, isPreLiquidationContractAuthorized] = await Promise.all([
          getPreLiquidationOraclePrice(client, preLiquidationContract, position),
          readContract(client, {
            address: morphoAddress,
            abi: morphoBlueAbi,
            functionName: "isAuthorized",
            args: [position.user, preLiquidationContract.address],
          }),
        ]);

        if (isPreLiquidationContractAuthorized === false) return null;

        const preLiquidatablePosition = new PreLiquidationPosition(
          {
            preLiquidationParams: preLiquidationContract.preLiquidationParams,
            preLiquidation: preLiquidationContract.address,
            preLiquidationOraclePrice: preLiquidationOraclePrice,
            ...position,
          },
          position.market,
        );
        const preSeizableCollateral = preLiquidatablePosition.seizableCollateral;

        if (preSeizableCollateral === undefined || preSeizableCollateral === 0n) return null;

        return preLiquidatablePosition;
      }),
    );

    return preLiquidatablePositions.filter(
      (position) => position !== null,
    ) as PreLiquidationPosition[];
  } catch (error) {
    throw new Error(`Error fetching pre-liquidatable positions: ${error}`);
  }
}

async function getPreLiquidationOraclePrice(
  client: Client<Transport, Chain, Account>,
  preLiquidationContract: PreLiquidationContract,
  position: AccrualPosition,
) {
  const preLiquidationOraclePrice =
    preLiquidationContract.preLiquidationParams.preLiquidationOracle ===
    position.market.params.oracle
      ? position.market.price
      : await readContract(client, {
          address: preLiquidationContract.preLiquidationParams.preLiquidationOracle,
          abi: oracleAbi,
          functionName: "price",
        });

  return preLiquidationOraclePrice;
}
