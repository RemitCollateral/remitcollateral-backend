import { Loan, Beneficiary } from "../types";
import { logAuditEvent } from "./audit.service";

/**
 * Notification Service
 *
 * The architecture calls for notifications at three points in the loan
 * lifecycle: the beneficiary is notified by SMS when a loan is disbursed
 * (§3.2, §7.1), both parties are notified when a loan enters grace (§3.5),
 * and the guarantor is notified when collateral is forfeited (§7.3).
 *
 * The beneficiary has no wallet and no app, so SMS to the phone number the
 * off-ramp partner holds is the only channel that reaches them. V1 logs to
 * the console and to the audit trail; a real SMS provider drops in behind
 * `sendSms` without changing any caller.
 */

// ─── Transport ───────────────────────────────────────────────────────

function sendSms(phoneNumber: string, body: string): void {
  console.log(`[SMS → ${phoneNumber}]: ${body}`);

  logAuditEvent({
    eventType: "SYSTEM",
    action: "SMS_SENT",
    entityType: "beneficiary_phone",
    details: { phoneNumber, body },
  });
}

function notifyGuarantor(guarantorId: string, body: string): void {
  console.log(`[Notify guarantor ${guarantorId}]: ${body}`);

  logAuditEvent({
    eventType: "SYSTEM",
    action: "GUARANTOR_NOTIFIED",
    actor: guarantorId,
    entityType: "guarantor",
    entityId: guarantorId,
    details: { body },
  });
}

// ─── Lifecycle Notifications ─────────────────────────────────────────

/**
 * Sent to the beneficiary once the off-ramp partner confirms disbursement
 * (§3.2 step 5). Carries the repayment schedule, because the beneficiary
 * has no dashboard to look it up in.
 */
export function notifyLoanDisbursed(loan: Loan, beneficiary: Beneficiary): void {
  const first = loan.schedule[0];
  const firstDue = first ? new Date(first.dueAt).toISOString().slice(0, 10) : "n/a";
  const perInstallment = first ? first.amountLocal : 0;

  sendSms(
    beneficiary.phoneNumber,
    `Loan received: ${loan.principalLocal} ${loan.localCurrency}. ` +
    `Repay in ${loan.installmentCount} installments of about ` +
    `${perInstallment} ${loan.localCurrency}, every ${loan.installmentIntervalDays} days. ` +
    `First payment due ${firstDue}.`,
  );
}

/**
 * Sent to both parties when a missed installment puts the loan into grace
 * (§3.5 step 1). The beneficiary gets the deadline; the guarantor gets the
 * default risk, stated plainly rather than buried.
 */
export function notifyGracePeriodEntered(
  loan: Loan,
  beneficiary: Beneficiary,
  installmentNumber: number,
): void {
  const graceEnds = loan.graceExpiresAt
    ? new Date(loan.graceExpiresAt).toISOString().slice(0, 10)
    : "shortly";

  sendSms(
    beneficiary.phoneNumber,
    `Payment ${installmentNumber} on your ${loan.localCurrency} loan is overdue. ` +
    `Please pay by ${graceEnds} to avoid default.`,
  );

  notifyGuarantor(
    loan.guarantorId,
    `Loan ${loan.id} has entered its grace period: installment ${installmentNumber} ` +
    `was missed. If it is not paid by ${graceEnds}, part of your collateral will be forfeited.`,
  );
}

/**
 * Sent to the guarantor when forfeited collateral is moved to the platform
 * settlement address (§3.5, §7.3).
 */
export function notifyCollateralForfeited(
  loan: Loan,
  forfeitedUsd: number,
  returnedUsd: number,
): void {
  notifyGuarantor(
    loan.guarantorId,
    `Loan ${loan.id} has defaulted. ${forfeitedUsd} USDC of your collateral has been ` +
    `forfeited to cover the outstanding balance; ${returnedUsd} USDC has been unlocked ` +
    `and returned to your available balance.`,
  );
}

/**
 * Sent to both parties when the final installment is attested and the full
 * collateral, including the safety buffer, is released (§3.4).
 */
export function notifyLoanRepaid(loan: Loan, beneficiary: Beneficiary): void {
  sendSms(
    beneficiary.phoneNumber,
    `Your ${loan.principalLocal} ${loan.localCurrency} loan is fully repaid. Thank you.`,
  );

  notifyGuarantor(
    loan.guarantorId,
    `Loan ${loan.id} is fully repaid. All collateral, including the safety buffer, ` +
    `has been released back to your available balance.`,
  );
}
