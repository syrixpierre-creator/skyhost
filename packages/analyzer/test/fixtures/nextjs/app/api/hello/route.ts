export async function GET() { return Response.json({ key: process.env.STRIPE_SECRET_KEY ? 'set' : 'unset' }); }
