import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import { ts } from 'ts-morph';

for (const scenario of ['already registered', 'initially absent']) {
  test(`renderer keeps one default Trusted Types policy (${scenario})`, async ({
    page,
  }) => {
    const source = await readFile(
      new URL('../src/utils/trusted-types.ts', import.meta.url),
      'utf8',
    );
    const { outputText } = ts.transpileModule(source, {
      compilerOptions: {
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ESNext,
      },
    });
    await page.route('https://fixture.invalid/', (route) =>
      route.fulfill({
        contentType: 'text/html',
        headers: {
          'content-security-policy':
            "trusted-types default; require-trusted-types-for 'script'",
        },
        body: '<!doctype html><div id="content"></div>',
      }),
    );
    await page.goto('https://fixture.invalid/');
    const result = await page.evaluate(
      async ({ code, existingPolicy }) => {
        const tt = window.trustedTypes!;
        if (existingPolicy) {
          tt.createPolicy('default', {
            createHTML: (value) => value.toUpperCase(),
          });
        }
        const renderer = await import(
          'data:text/javascript,' + encodeURIComponent(code)
        );
        renderer.registerWindowDefaultTrustedTypePolicy();
        const registered = tt.defaultPolicy;
        renderer.registerWindowDefaultTrustedTypePolicy();
        const content = document.getElementById('content')!;
        content.innerHTML =
          renderer.defaultTrustedTypePolicy.createHTML('hello');
        return {
          samePolicy:
            renderer.defaultTrustedTypePolicy === registered &&
            tt.defaultPolicy === registered,
          text: content.textContent,
        };
      },
      { code: outputText, existingPolicy: scenario === 'already registered' },
    );
    expect(result).toEqual({
      samePolicy: true,
      text: scenario === 'already registered' ? 'HELLO' : 'hello',
    });
  });
}
