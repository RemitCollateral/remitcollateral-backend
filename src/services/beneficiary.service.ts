import { Beneficiary, BeneficiaryLink } from "../types";
import { beneficiaries, beneficiaryLinks, generateId } from "../stores";

export class BeneficiaryConflict extends Error {}

export interface BeneficiaryInput {
  phoneNumber: string;
  localKycRef: string;
  localCurrency: string;
  displayName?: string;
}

/** The guarantor's link to a beneficiary, if they support them. */
export function linkOf(guarantorId: string, beneficiaryId: string): BeneficiaryLink | undefined {
  return beneficiaryLinks.get(guarantorId)?.get(beneficiaryId);
}

/** The beneficiaries a guarantor supports, most recently added first. */
export function beneficiariesOf(
  guarantorId: string,
): Array<{ beneficiary: Beneficiary; link: BeneficiaryLink }> {
  const links = beneficiaryLinks.get(guarantorId);
  if (!links) return [];
  return Array.from(links.values())
    .flatMap((link) => {
      const beneficiary = beneficiaries.get(link.beneficiaryId);
      return beneficiary ? [{ beneficiary, link }] : [];
    })
    .sort((a, b) => b.link.createdAt.localeCompare(a.link.createdAt));
}

/**
 * Add a beneficiary to a guarantor's list.
 *
 * A beneficiary is one person however many guarantors support them, so a phone
 * number that is already registered is linked rather than duplicated, but only
 * when the partner KYC reference matches as well. The KYC reference is what
 * shows the guarantor knows this person through the partner; a phone number
 * alone would let anyone attach themselves to a stranger's credit history.
 */
export function addBeneficiary(
  guarantorId: string,
  input: BeneficiaryInput,
): { beneficiary: Beneficiary; link: BeneficiaryLink; created: boolean } {
  const now = new Date().toISOString();
  let beneficiary = Array.from(beneficiaries.values()).find(
    (b) => b.phoneNumber === input.phoneNumber,
  );
  let created = false;

  if (beneficiary) {
    if (beneficiary.localKycRef !== input.localKycRef) {
      throw new BeneficiaryConflict("This phone number is registered with a different KYC reference");
    }
    if (linkOf(guarantorId, beneficiary.id)) {
      throw new BeneficiaryConflict("This beneficiary is already on your list");
    }
  } else {
    beneficiary = {
      id: generateId(),
      phoneNumber: input.phoneNumber,
      localKycRef: input.localKycRef,
      reputationScore: 0,
      localCurrency: input.localCurrency,
      createdAt: now,
    };
    beneficiaries.set(beneficiary.id, beneficiary);
    created = true;
  }

  const link: BeneficiaryLink = {
    guarantorId,
    beneficiaryId: beneficiary.id,
    displayName: input.displayName,
    createdAt: now,
  };
  if (!beneficiaryLinks.has(guarantorId)) beneficiaryLinks.set(guarantorId, new Map());
  beneficiaryLinks.get(guarantorId)!.set(beneficiary.id, link);

  return { beneficiary, link, created };
}
