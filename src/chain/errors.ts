export type ContractName = "vault" | "ledger" | "engine";

const TIMELOCK: Record<string, [string, string]> = {
  NoPendingAction: ["NoPendingAction", "No admin change is scheduled"],
  ActionPending: ["ActionPending", "An admin change is already scheduled"],
  TimelockNotExpired: ["TimelockNotExpired", "The scheduled change cannot run until its timelock expires"],
};

/** Contract error codes, from each contract's `Error` enum. */
const CODES: Record<ContractName, Record<number, [string, string]>> = {
  vault: {
    2: ["NotInitialized", "The vault contract is not set up"],
    3: ["NotAuthorized", "Not authorized to do that on the vault"],
    4: ["InvalidAmount", "The amount must be positive"],
    5: ["InsufficientAvailable", "Not enough unlocked collateral in the vault"],
    6: ["InsufficientLocked", "Not that much collateral is locked"],
    7: ["LedgerNotSet", "The vault is not wired to a loan ledger"],
    8: ["EngineNotSet", "The vault is not wired to a liquidation engine"],
    9: ["AlreadySet", "That wiring is already set"],
    10: TIMELOCK.NoPendingAction,
    11: TIMELOCK.ActionPending,
    12: TIMELOCK.TimelockNotExpired,
  },
  ledger: {
    2: ["NotInitialized", "The loan ledger is not set up"],
    3: ["NotAuthorized", "Not authorized to do that on the loan ledger"],
    4: ["InvalidAmount", "The amount must be positive"],
    5: ["InvalidSchedule", "A loan needs at least one installment and a positive interval"],
    6: ["InvalidConfig", "The loan ledger's configuration is invalid"],
    7: ["InvalidScore", "A reputation score must be between 0 and 10,000 basis points"],
    8: ["LoanNotFound", "No such loan on chain"],
    9: ["LoanNotActive", "The loan is not open"],
    10: ["LoanAlreadyOpen", "This beneficiary already has an open loan from this guarantor"],
    11: ["NotOverdue", "The loan is not overdue"],
    12: ["GraceNotExpired", "The loan's grace period has not expired"],
    13: ["Overpayment", "That repayment is more than the principal outstanding"],
    14: ["UnknownPartner", "That off-ramp partner is not registered"],
    15: ["UnknownVerifier", "That verifier is not registered"],
    16: ["RoleConflict", "An address cannot be both a partner and a verifier"],
    17: ["AlreadySet", "That wiring is already set"],
    18: TIMELOCK.NoPendingAction,
    19: TIMELOCK.ActionPending,
    20: TIMELOCK.TimelockNotExpired,
  },
  engine: {
    2: ["NotInitialized", "The liquidation engine is not set up"],
    3: ["NotAuthorized", "Not authorized to do that on the liquidation engine"],
    4: ["NotOverdue", "The loan is not overdue"],
    5: ["GraceNotExpired", "The loan's grace period has not expired"],
    6: TIMELOCK.NoPendingAction,
    7: TIMELOCK.ActionPending,
    8: TIMELOCK.TimelockNotExpired,
  },
};

/** A failure on chain, with the contract and error it came from when known. */
export class ChainError extends Error {
  constructor(
    message: string,
    readonly contract?: ContractName,
    readonly code?: number,
    readonly reason?: string,
  ) {
    super(message);
    this.name = "ChainError";
  }
}

/**
 * Turn a simulation or submission failure into a ChainError.
 *
 * A contract error can come from a contract other than the one invoked: a
 * loan originated on the ledger fails inside the vault when collateral is
 * short. The diagnostic events name the contract that raised it, so that is
 * the one attributed, falling back to the contract that was invoked.
 */
export function chainErrorFrom(
  detail: unknown,
  invoked: ContractName,
  contractIds: Record<ContractName, string>,
): ChainError {
  const text = detail instanceof Error ? detail.message : String(detail ?? "");
  const byId = new Map(Object.entries(contractIds).map(([name, id]) => [id, name as ContractName]));

  const raised = [...text.matchAll(/contract:(C[A-Z2-7]{55}), topics:\[error, Error\(Contract, #(\d+)\)\]/g)];
  let contract: ContractName | undefined;
  let code: number | undefined;
  if (raised.length > 0) {
    const origin = raised[raised.length - 1]; // the log is newest first
    contract = byId.get(origin[1]) ?? invoked;
    code = Number(origin[2]);
  } else {
    const plain = /Error\(Contract, #(\d+)\)/.exec(text);
    if (plain) {
      contract = invoked;
      code = Number(plain[1]);
    }
  }

  if (contract && code !== undefined) {
    const known = CODES[contract][code];
    if (known) return new ChainError(known[1], contract, code, known[0]);
    return new ChainError(`The ${contract} contract refused the call (error ${code})`, contract, code);
  }
  if (/Error\(Auth,/.test(text) || /failed account authentication/.test(text)) {
    return new ChainError("The transaction is missing a required signature", invoked, undefined, "Auth");
  }
  return new ChainError(text.split("\n")[0] || "The chain call failed", invoked);
}
