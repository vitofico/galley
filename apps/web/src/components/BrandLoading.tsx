export function BrandLoading({
  label = "Opening your workspace…",
}: {
  label?: string;
}) {
  return (
    <div className="brand-loading" role="status" aria-busy="true">
      <span className="brand">Galley</span>
      <span className="brand-loading-rule" aria-hidden="true" />
      <span>{label}</span>
    </div>
  );
}
