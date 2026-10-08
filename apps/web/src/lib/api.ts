import { Sluice } from "@sluice/sdk";

export type * from "@sluice/sdk";
export { SluiceError } from "@sluice/sdk";

/** One origin serves the app and the API (in development Vite proxies /v1 to the API process). */
export const api = new Sluice(window.location.origin);

export const USDC = "USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";
