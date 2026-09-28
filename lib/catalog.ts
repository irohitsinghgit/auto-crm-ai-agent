import catalog from '../data/vehicles.json';

type VehicleModel = (typeof catalog.models)[number];
type Variant = VehicleModel['variants'][number];

export const MODEL_NAMES = catalog.models.map((m) => m.model);

const normalize = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, '');

const lakh = (amount: number) => `₹${(amount / 100000).toFixed(2)} lakh`;
const priceRange = ([min, max]: number[]) => `${lakh(min)} - ${lakh(max)}`;

// Longest-prefix match so inputs like "Scorpio-N Z8L" or "xuv 700 ax7" resolve to the model.
export function matchModel(input: string): VehicleModel | null {
  const query = normalize(input);
  let best: { model: VehicleModel; length: number } | null = null;

  for (const model of catalog.models) {
    for (const key of [model.model, ...model.aliases].map(normalize)) {
      if (query.startsWith(key) && key.length > (best?.length ?? 0)) {
        best = { model, length: key.length };
      }
    }
  }
  return best?.model ?? null;
}

function matchVariant(model: VehicleModel, input: string): Variant | null {
  const query = normalize(input);
  const candidates = model.variants
    .filter((v) => query === normalize(v.name) || query.endsWith(normalize(v.name)))
    .sort((a, b) => normalize(b.name).length - normalize(a.name).length);
  return candidates[0] ?? null;
}

// Canonical "Model Variant" label for CRM records, e.g. "xuv 700 ax7" -> "XUV700 AX7".
export function vehicleLabel(input: string): string | null {
  const model = matchModel(input);
  if (!model) return null;
  const variant = matchVariant(model, input);
  return variant ? `${model.model} ${variant.name}` : model.model;
}

export function getVehicleInfo(modelInput: string, variantInput?: string) {
  const model = matchModel(modelInput);
  if (!model) {
    return { found: false as const, message: `No model matching "${modelInput}".`, availableModels: MODEL_NAMES };
  }

  const variantQuery = variantInput || modelInput;
  const variant = matchVariant(model, variantQuery);
  const base = {
    found: true as const,
    model: model.model,
    bodyType: model.bodyType,
    engines: model.engines,
    transmissions: model.transmissions,
    drivetrain: model.drivetrain,
    safety: model.safety,
    ...('offRoad' in model ? { offRoad: model.offRoad } : {}),
    priceNote: catalog.priceNote,
  };

  if (variant) {
    return {
      ...base,
      variant: {
        name: variant.name,
        exShowroomPrice: priceRange(variant.priceRange),
        seating: variant.seating,
        highlights: variant.highlights,
      },
    };
  }

  const prices = model.variants.flatMap((v) => v.priceRange);
  return {
    ...base,
    ...(variantInput ? { variantNotFound: `No ${model.model} variant named "${variantInput}".` } : {}),
    exShowroomPrice: priceRange([Math.min(...prices), Math.max(...prices)]),
    variants: model.variants.map((v) => ({
      name: v.name,
      exShowroomPrice: priceRange(v.priceRange),
      seating: v.seating,
      highlights: v.highlights,
    })),
  };
}
