import { Router, Request, Response } from "express";
import { walletAuth } from "../middleware/auth.middleware";
import { quoteExchangeRate } from "../services/loan.service";

export const fxRouter = Router();

/**
 * GET /fx/rates/:currency — The off-ramp partner's current rate, in local
 * units per 1 USD: the rate a loan in that currency is priced at.
 */
fxRouter.get("/rates/:currency", walletAuth, async (req: Request, res: Response) => {
  const currency = req.params.currency.toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) {
    return res.status(400).json({ error: "currency must be an ISO 4217 code, e.g. NGN" });
  }

  try {
    const quote = await quoteExchangeRate(currency);
    return res.json({
      local_currency: quote.local_currency,
      local_per_usd: quote.local_per_usd,
      quoted_at: quote.quoted_at,
    });
  } catch (err) {
    return res.status(400).json({ error: (err as Error).message });
  }
});
