import { PricerName } from "@morpho-blue-liquidation-bot/config";

import { Pricer } from "./pricer";
import { DefiLlamaPricer } from "./defillama";
import { ChainlinkPricer } from "./chainlink";
import { MorphoApi } from "./morphoApi";
import { UniswapV3Pricer } from "./uniswapV3";
/**
 * Creates a pricer instance based on the pricer name from config.
 * This factory function avoids circular dependencies by keeping pricer
 * class imports in the client package, while config only exports string identifiers.
 */
export function createPricer(pricerName: PricerName): Pricer {
  switch (pricerName) {
    case "defillama":
      return new DefiLlamaPricer();
    case "chainlink":
      return new ChainlinkPricer();
    case "morphoApi":
      return new MorphoApi();
    case "uniswapV3":
      return new UniswapV3Pricer();
    default:
      throw new Error(`Unknown pricer: ${pricerName}`);
  }
}
