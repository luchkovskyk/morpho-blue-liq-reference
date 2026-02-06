import type { ChainConfig } from "@morpho-blue-liquidation-bot/config";
import { createWalletClient, Hex, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { watchBlocks } from "viem/actions";

import { LiquidationBot, type LiquidationBotInputs } from "./bot";
import { createPricer } from "./pricers";
import { createLiquidityVenue } from "./liquidityVenues";

export const launchBot = (config: ChainConfig) => {
  const logTag = `[${config.chain.name} client]: `;
  console.log(`${logTag}Starting up`);

  const client = createWalletClient({
    chain: config.chain,
    transport: http(config.rpcUrl),
    account: privateKeyToAccount(config.liquidationPrivateKey),
  });

  // LIQUIDITY VENUES
  const liquidityVenues = config.liquidityVenues.map((liquidityVenueName) =>
    createLiquidityVenue(liquidityVenueName),
  );

  // PRICERS
  const pricers = config.pricers
    ? config.pricers.map((pricerName) => createPricer(pricerName))
    : undefined;

  // FlASHBOTS

  let flashbotAccount = undefined;
  if (config.useFlashbots) {
    const flashbotsPrivateKey = process.env.FLASHBOTS_PRIVATE_KEY;

    if (flashbotsPrivateKey === undefined) {
      throw new Error(`${logTag} FLASHBOTS_PRIVATE_KEY is not set`);
    }

    flashbotAccount = privateKeyToAccount(process.env.FLASHBOTS_PRIVATE_KEY as Hex);
  }

  const inputs: LiquidationBotInputs = {
    logTag,
    chainId: config.chainId,
    client,
    morphoAddress: config.morpho.address,
    wNative: config.wNative,
    vaultWhitelist: config.vaultWhitelist,
    additionalMarketsWhitelist: config.additionalMarketsWhitelist,
    executorAddress: config.executorAddress,
    treasuryAddress: config.treasuryAddress ?? client.account.address,
    liquidityVenues,
    pricers,
    flashbotAccount,
  };

  const bot = new LiquidationBot(inputs);

  const blockInterval = config.blockInterval ?? 1;
  let count = 0;

  watchBlocks(client, {
    onBlock: () => {
      if (count % blockInterval === 0) {
        try {
          void bot.run();
        } catch (e) {
          console.error(`${logTag} uncaught error in bot.run():`, e);
        }
      }
      count++;
    },
  });
};
