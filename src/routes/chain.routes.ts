import { Router, Request, Response } from "express";
import { config } from "../config";
import { activeChain } from "../chain/runtime";

export const chainRouter = Router();

/**
 * GET /chain — Whether this backend is connected to the contracts. When it is,
 * guarantor actions are signed by the guarantor's wallet: prepare, sign, submit.
 */
chainRouter.get("/", (_req: Request, res: Response) => {
  const enabled = activeChain() !== null;
  res.json({
    enabled,
    network_passphrase: enabled ? config.chain.networkPassphrase : null,
  });
});
