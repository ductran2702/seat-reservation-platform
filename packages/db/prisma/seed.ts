import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

const prisma = new PrismaClient();

const SEAT_LABELS = ["A1", "A2", "A3"];

async function main() {
  // Seed exactly 3 seats (idempotent).
  for (const label of SEAT_LABELS) {
    await prisma.seat.upsert({
      where: { label },
      update: {},
      create: { label },
    });
  }

  // Seed a demo user so the app is usable immediately.
  const email = process.env.DEMO_USER_EMAIL ?? "demo@example.com";
  const password = process.env.DEMO_USER_PASSWORD ?? "password123";
  const passwordHash = await bcrypt.hash(password, 10);

  await prisma.user.upsert({
    where: { email },
    update: {},
    create: { email, name: "Demo User", passwordHash },
  });

  const seats = await prisma.seat.findMany({ orderBy: { label: "asc" } });
  console.log(`Seeded ${seats.length} seats: ${seats.map((s) => s.label).join(", ")}`);
  console.log(`Demo login -> email: ${email}  password: ${password}`);
}

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (err) => {
    console.error(err);
    await prisma.$disconnect();
    process.exit(1);
  });
