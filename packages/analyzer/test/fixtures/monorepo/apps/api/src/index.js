require('fastify')().listen({ port: Number(process.env.PORT) || 4000, host: '0.0.0.0' });
