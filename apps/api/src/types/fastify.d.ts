import 'fastify';

import type { OrgRole } from '@aligned/shared';

declare module 'fastify' {
  interface FastifyRequest {
    auth?: {
      userId: string;
      organizationId: string;
      role: OrgRole;
      isAlignedAdmin: boolean;
      sessionId: string;
    };
  }
}
