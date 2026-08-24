import { config } from "../config";
import {
  beneficiaries,
  remittanceRecords,
  loans,
} from "../stores";
import { logAuditEvent } from "./audit.service";

// ─── Reputation Engine (§8) ──────────────────────────────────────────

export function computeRemittanceConsistencyScore(beneficiaryId: string): number {
  const records = remittanceRecords
    .filter((r) => r.beneficiaryId === beneficiaryId && r.source === "partner_reported")
    .sort((a, b) => new Date(a.sentAt).getTime() - new Date(b.sentAt).getTime());

  if (records.length === 0) return 0;

  const earliest = new Date(records[0].sentAt);
  const latest = new Date(records[records.length - 1].sentAt);
  const durationMonths =
    (latest.getTime() - earliest.getTime()) / (1000 * 60 * 60 * 24 * 30);

  if (durationMonths < config.protocol.minRemittanceMonths) {
    return Math.min(20, records.length * 5);
  }

  const gaps: number[] = [];
  for (let i = 1; i < records.length; i++) {
    const gap =
      (new Date(records[i].sentAt).getTime() - new Date(records[i - 1].sentAt).getTime()) /
      (1000 * 60 * 60 * 24);
    gaps.push(gap);
  }

  const avgGapDays = gaps.reduce((a, b) => a + b, 0) / gaps.length;
  const frequencyScore = Math.max(0, 40 - Math.abs(avgGapDays - 30) * 0.5);

  const amounts = records.map((r) => r.amountUsd);
  const avgAmount = amounts.reduce((a, b) => a + b, 0) / amounts.length;
  const variance =
    amounts.reduce((sum, a) => sum + Math.pow(a - avgAmount, 2), 0) / amounts.length;
  const cv = avgAmount > 0 ? Math.sqrt(variance) / avgAmount : 1;
  const consistencyScore = Math.max(0, 30 * (1 - Math.min(1, cv)));

  const durationScore = Math.min(30, (durationMonths / 24) * 30);

  return Math.round(frequencyScore + consistencyScore + durationScore);
}

export function computeRepaymentScore(beneficiaryId: string): number {
  const beneficiaryLoans = Array.from(loans.values()).filter(
    (l) => l.beneficiaryId === beneficiaryId,
  );

  if (beneficiaryLoans.length === 0) return 0;

  let totalInstallments = 0;
  let onTimeInstallments = 0;

  for (const loan of beneficiaryLoans) {
    for (const item of loan.schedule) {
      if (item.status === "repaid") {
        totalInstallments++;
        if (item.repaidAt && new Date(item.repaidAt) <= new Date(item.dueAt)) {
          onTimeInstallments++;
        }
      } else if (item.status === "overdue") {
        totalInstallments++;
      }
    }
  }

  if (totalInstallments === 0) return 0;
  return Math.round((onTimeInstallments / totalInstallments) * 100);
}

export function computeCompositeScore(beneficiaryId: string): number {
  const remittanceScore = computeRemittanceConsistencyScore(beneficiaryId);
  const repaymentScore = computeRepaymentScore(beneficiaryId);

  const composite = Math.round(
    remittanceScore * config.protocol.remittanceWeight +
    repaymentScore * config.protocol.repaymentWeight,
  );

  return Math.min(100, Math.max(0, composite));
}

export function computeAdjustedLtv(beneficiaryId: string): number {
  const score = computeCompositeScore(beneficiaryId);
  const { defaultLtvRatio, minLtvRatio, ltvReductionFactor } = config.protocol;

  const adjustedLtv = Math.max(minLtvRatio, defaultLtvRatio - score * ltvReductionFactor);
  return Math.round(adjustedLtv * 100) / 100;
}

export function refreshReputationScore(beneficiaryId: string): number {
  const beneficiary = beneficiaries.get(beneficiaryId);
  if (!beneficiary) throw new Error(`Beneficiary ${beneficiaryId} not found`);

  const newScore = computeCompositeScore(beneficiaryId);
  const oldScore = beneficiary.reputationScore;
  beneficiary.reputationScore = newScore;
  beneficiaries.set(beneficiaryId, beneficiary);

  if (newScore !== oldScore) {
    logAuditEvent({
      eventType: "REPUTATION",
      action: "SCORE_UPDATED",
      entityType: "beneficiary",
      entityId: beneficiaryId,
      details: { oldScore, newScore, delta: newScore - oldScore },
    });
  }

  return newScore;
}

export function getReputationBreakdown(beneficiaryId: string) {
  const remittanceScore = computeRemittanceConsistencyScore(beneficiaryId);
  const repaymentScore = computeRepaymentScore(beneficiaryId);
  const compositeScore = computeCompositeScore(beneficiaryId);
  const adjustedLtv = computeAdjustedLtv(beneficiaryId);

  const totalPartnerRemittances = remittanceRecords.filter(
    (r) => r.beneficiaryId === beneficiaryId && r.source === "partner_reported",
  ).length;

  const totalLoans = Array.from(loans.values()).filter(
    (l) => l.beneficiaryId === beneficiaryId,
  ).length;

  return {
    compositeScore, remittanceScore, repaymentScore, adjustedLtv,
    remittanceWeight: config.protocol.remittanceWeight,
    repaymentWeight: config.protocol.repaymentWeight,
    totalPartnerRemittances, totalLoans,
  };
}
