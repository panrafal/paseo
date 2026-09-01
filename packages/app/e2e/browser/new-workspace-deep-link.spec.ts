import { expect, test } from "../support/fixtures";
import { getServerId } from "../support/helpers/server-id";

test("a new-workspace deep link preserves query context and prefills its fragment prompt", async ({
  page,
}) => {
  const serverId = getServerId();
  const prompt = "Fix auth & add # regression coverage\nThen run the focused tests.";
  const fragment = new URLSearchParams({ q: prompt }).toString();

  await page.goto(`/new?serverId=${encodeURIComponent(serverId)}#${fragment}`);

  await expect
    .poll(() => {
      const url = new URL(page.url());
      return {
        pathname: url.pathname,
        serverId: url.searchParams.get("serverId"),
        fragment: url.hash.slice(1),
      };
    })
    .toEqual({ pathname: "/new", serverId, fragment });
  await expect(page.getByRole("textbox", { name: "Message agent..." })).toHaveValue(prompt, {
    timeout: 30_000,
  });
});
