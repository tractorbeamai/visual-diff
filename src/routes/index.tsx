import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/")({
  component: IndexPage,
});

function IndexPage() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-950 text-gray-400">
      <p className="text-sm">
        Navigate to <code>/:owner/:repo/pull/:number</code> to view a PR.
      </p>
    </div>
  );
}
