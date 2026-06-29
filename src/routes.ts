import { Router, Request, Response } from "express";

export const router = Router();

// In-Memory Database to mimic PostgreSQL for easy local setup
interface Property {
  id: number;
  titleHash: string;
  trustee: string;
  surveyDocHash: string;
  usdcValue: number;
  status: "Pending" | "Verified" | "Tokenized" | "Mortgaged" | "Repaid" | "Defaulted";
  tokenAddress?: string;
  milestones: {
    stage: number;
    evidenceHash: string;
    verified: boolean;
    released: boolean;
  }[];
}

interface User {
  address: string;
  name: string;
  kycStatus: "None" | "Pending" | "Approved" | "Rejected";
  role: "Diaspora" | "Investor" | "Trustee" | "Builder";
}

const properties: Map<number, Property> = new Map();
const users: Map<string, User> = new Map();
let propertyIdCounter = 1;

// Seed some initial users/data for the sandbox
users.set("GD3W...1234", {
  address: "GD3W...1234",
  name: "Kofi Mensah",
  kycStatus: "Approved",
  role: "Trustee",
});
users.set("GB5X...5678", {
  address: "GB5X...5678",
  name: "Chinedu Okafor",
  kycStatus: "Approved",
  role: "Diaspora",
});

// 1. KYC / Identity Verification (Smile ID integration mock)
router.post("/kyc/verify", (req: Request, res: Response) => {
  const { address, name, documentNumber, documentType, role } = req.body;

  if (!address || !name || !documentNumber || !documentType || !role) {
    return res.status(400).json({ error: "Missing required KYC fields" });
  }

  // Simulate document verification delay & approval
  const kycStatus = "Approved";
  const user: User = {
    address,
    name,
    kycStatus,
    role,
  };

  users.set(address, user);

  console.log(`[KYC]: User ${name} (${address}) verified successfully as ${role}`);
  return res.json({
    message: "KYC verification successful",
    user,
  });
});

// Get User Profile
router.get("/users/:address", (req: Request, res: Response) => {
  const { address } = req.params;
  const user = users.get(address);

  if (!user) {
    return res.status(404).json({ error: "User not found" });
  }

  return res.json(user);
});

// 2. Submit Property (Trustee)
router.post("/properties/submit", (req: Request, res: Response) => {
  const { titleHash, trustee, surveyDocHash } = req.body;

  if (!titleHash || !trustee || !surveyDocHash) {
    return res.status(400).json({ error: "Missing titleHash, trustee, or surveyDocHash" });
  }

  const id = propertyIdCounter++;
  const newProperty: Property = {
    id,
    titleHash,
    trustee,
    surveyDocHash,
    usdcValue: 0,
    status: "Pending",
    milestones: [
      { stage: 0, evidenceHash: "", verified: false, released: false }, // Foundation
      { stage: 1, evidenceHash: "", verified: false, released: false }, // Walls
      { stage: 2, evidenceHash: "", verified: false, released: false }, // Roofing
      { stage: 3, evidenceHash: "", verified: false, released: false }, // Finishing
      { stage: 4, evidenceHash: "", verified: false, released: false }, // Handover
    ],
  };

  properties.set(id, newProperty);

  console.log(`[Property]: Property ID ${id} submitted by trustee ${trustee}`);
  return res.status(201).json({
    message: "Property submitted successfully",
    property: newProperty,
  });
});

// Get Property Details
router.get("/properties/:id", (req: Request, res: Response) => {
  const id = parseInt(req.params.id);
  const property = properties.get(id);

  if (!property) {
    return res.status(404).json({ error: "Property not found" });
  }

  return res.json(property);
});

// 3. Verify Title (Oracle / MLHUD / Lands Commission mock)
router.post("/properties/:id/verify-title", (req: Request, res: Response) => {
  const id = parseInt(req.params.id);
  const property = properties.get(id);

  if (!property) {
    return res.status(404).json({ error: "Property not found" });
  }

  if (property.status !== "Pending") {
    return res.status(400).json({ error: "Property is already verified or tokenized" });
  }

  // Simulating land registry check
  property.status = "Verified";
  properties.set(id, property);

  console.log(`[Oracle]: Title for Property ID ${id} verified via Land Registry API`);
  return res.json({
    message: "Title verified successfully by Land Registry Oracle",
    property,
  });
});

// 4. Set Property Valuation (Licensed Surveyor / Oracle)
router.post("/properties/:id/valuation", (req: Request, res: Response) => {
  const id = parseInt(req.params.id);
  const { usdcValue } = req.body;

  if (!usdcValue || typeof usdcValue !== "number") {
    return res.status(400).json({ error: "Invalid or missing usdcValue" });
  }

  const property = properties.get(id);

  if (!property) {
    return res.status(404).json({ error: "Property not found" });
  }

  if (property.status !== "Verified") {
    return res.status(400).json({ error: "Property must be verified before setting valuation" });
  }

  property.usdcValue = usdcValue;
  properties.set(id, property);

  console.log(`[Oracle]: Valuation for Property ID ${id} set to $${usdcValue} USDC`);
  return res.json({
    message: "Property valuation recorded successfully",
    property,
  });
});

// 5. Submit Milestone Evidence (Trustee / Builder)
router.post("/properties/:id/milestones/submit", (req: Request, res: Response) => {
  const id = parseInt(req.params.id);
  const { stage, evidenceHash } = req.body;

  if (stage === undefined || !evidenceHash) {
    return res.status(400).json({ error: "Missing stage or evidenceHash" });
  }

  const property = properties.get(id);

  if (!property) {
    return res.status(404).json({ error: "Property not found" });
  }

  const milestone = property.milestones.find((m) => m.stage === stage);
  if (!milestone) {
    return res.status(400).json({ error: "Invalid milestone stage" });
  }

  milestone.evidenceHash = evidenceHash;
  properties.set(id, property);

  console.log(`[Milestone]: Evidence for Property ID ${id}, Stage ${stage} submitted: ${evidenceHash}`);
  return res.json({
    message: "Milestone evidence submitted successfully",
    property,
  });
});

// 6. Verify Milestone (Oracle)
router.post("/properties/:id/milestones/verify", (req: Request, res: Response) => {
  const id = parseInt(req.params.id);
  const { stage } = req.body;

  if (stage === undefined) {
    return res.status(400).json({ error: "Missing stage" });
  }

  const property = properties.get(id);

  if (!property) {
    return res.status(404).json({ error: "Property not found" });
  }

  const milestone = property.milestones.find((m) => m.stage === stage);
  if (!milestone) {
    return res.status(400).json({ error: "Invalid milestone stage" });
  }

  if (!milestone.evidenceHash) {
    return res.status(400).json({ error: "No evidence submitted for this milestone yet" });
  }

  milestone.verified = true;
  properties.set(id, property);

  console.log(`[Oracle]: Milestone for Property ID ${id}, Stage ${stage} verified successfully`);
  return res.json({
    message: "Milestone verified successfully by Oracle",
    property,
  });
});
