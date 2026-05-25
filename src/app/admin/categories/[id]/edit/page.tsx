import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import CategoryForm from "../../CategoryForm";

export const dynamic = "force-dynamic";

export default async function EditCategoryPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const category = await prisma.category.findUnique({ where: { id } });
  if (!category) notFound();

  const serialized = {
    _id: category.id,
    name: category.name,
    slug: category.slug,
    position: category.position,
    active: category.active,
  };

  return (
    <div>
      <h1 className="mb-6 text-2xl font-bold">Edit Category</h1>
      <CategoryForm initialData={serialized} />
    </div>
  );
}
