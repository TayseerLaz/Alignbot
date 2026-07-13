// Public capability / contract-version probe for the Alinia integration.
//
// Alinia (the marketplace) auto-deploys on every push while Hader is deployed
// manually, so the two can sit at different contract versions for an unbounded
// window. Before pushing a mirror-ingest / lead / provisioning payload, Alinia
// GETs this endpoint and only sends a shape this Hader instance still accepts
// (both N and N-1 stay listed during a rollout). This prevents silent
// mis-parsing across the version-skew window — a stale side returns a clear
// answer instead of 400-ing on an unknown field.
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

// Bump when the Alinia <-> Hader payload shape changes in a breaking way. Keep
// the previous version in the list during a rollout so in-flight pushes don't
// get rejected mid-migration.
export const SUPPORTED_CONTRACT_VERSIONS = [1] as const;

export default async function integrationRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();

  // Public: no tenant auth. Returns only non-sensitive version metadata.
  r.get(
    '/integration/capabilities',
    {
      schema: {
        tags: ['integration'],
        summary: 'Alinia integration capabilities + supported contract versions (public).',
        response: {
          200: z.object({
            service: z.literal('hader'),
            contractVersions: z.array(z.number().int()),
            features: z.array(z.string()),
          }),
        },
      },
    },
    async () => ({
      service: 'hader' as const,
      contractVersions: [...SUPPORTED_CONTRACT_VERSIONS],
      features: ['listing_mirror', 'lead_callback', 'provisioning'],
    }),
  );
}
