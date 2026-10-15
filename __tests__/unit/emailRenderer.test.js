const { render } = require('../../src/core/services/emailRenderer');

/**
 * Renderer contract for the Handlebars-subset used by the compiled templates.
 *
 * The `{{#if}}…{{else}}…{{/if}}` case is the important one: a regression here
 * silently drops content for *truthy* conditions (the if-branch was never
 * pushed onto `branches`, so `branches[0]` stayed empty). That shipped and
 * blanked the "cancellation approved" header, the supplier cancellation
 * choice copy, the change-acceptance copy, and every sender avatar. These
 * assertions pin the branch selection so it cannot silently invert again.
 */
describe('emailRenderer', () => {
  describe('{{#if}} blocks', () => {
    it('renders the body when the value is truthy (no else)', () => {
      expect(render('{{#if x}}A{{/if}}', { x: 'yes' })).toBe('A');
    });

    it('renders nothing when the value is falsy (no else)', () => {
      expect(render('{{#if x}}A{{/if}}', { x: '' })).toBe('');
      expect(render('{{#if x}}A{{/if}}', {})).toBe('');
    });

    it('renders the if-branch — not the else-branch — when truthy', () => {
      expect(render('{{#if x}}A{{else}}B{{/if}}', { x: 'yes' })).toBe('A');
      expect(render('{{#if x}}A{{else}}B{{/if}}', { x: 1 })).toBe('A');
      expect(render('{{#if x}}A{{else}}B{{/if}}', { x: true })).toBe('A');
      expect(render('{{#if x}}A{{else}}B{{/if}}', { x: ['a'] })).toBe('A');
    });

    it('renders the else-branch when falsy', () => {
      expect(render('{{#if x}}A{{else}}B{{/if}}', { x: '' })).toBe('B');
      expect(render('{{#if x}}A{{else}}B{{/if}}', { x: 0 })).toBe('B');
      expect(render('{{#if x}}A{{else}}B{{/if}}', { x: false })).toBe('B');
      expect(render('{{#if x}}A{{else}}B{{/if}}', {})).toBe('B');
    });

    it('keeps multi-line branch bodies intact', () => {
      const src = '{{#if avatar}}\n<img src="{{avatar}}">\n{{else}}\nINITIALS\n{{/if}}';
      expect(render(src, { avatar: 'https://x/y.png' })).toContain('<img src="https://x/y.png">');
      expect(render(src, { avatar: 'https://x/y.png' })).not.toContain('INITIALS');
      expect(render(src, { avatar: '' })).toContain('INITIALS');
    });

    it('supports nested if/else', () => {
      const src = '{{#if a}}{{#if b}}X{{else}}Y{{/if}}{{else}}Z{{/if}}';
      expect(render(src, { a: 1, b: 1 })).toBe('X');
      expect(render(src, { a: 1, b: 0 })).toBe('Y');
      expect(render(src, { a: 0, b: 1 })).toBe('Z');
    });
  });

  describe('{{#each}} blocks', () => {
    it('iterates arrays and exposes fields', () => {
      const out = render('{{#each rows}}[{{label}}]{{/each}}', {
        rows: [{ label: 'a' }, { label: 'b' }],
      });
      expect(out).toBe('[a][b]');
    });

    it('renders nothing for missing or empty arrays', () => {
      expect(render('{{#each rows}}x{{/each}}', {})).toBe('');
      expect(render('{{#each rows}}x{{/each}}', { rows: [] })).toBe('');
    });

    it('supports {{#if}} inside {{#each}}', () => {
      const out = render('{{#each rows}}{{#if note}}<{{note}}>{{else}}-{{/if}}{{/each}}', {
        rows: [{ note: 'hi' }, {}],
      });
      expect(out).toBe('<hi>-');
    });
  });

  describe('variables', () => {
    it('substitutes known values and blanks unknown ones', () => {
      expect(render('Hi {{name}}', { name: 'Ada' })).toBe('Hi Ada');
      expect(render('Hi {{nope}}', { name: 'Ada' })).toBe('Hi ');
    });

    it('renders numbers and false-y primitives as their string form', () => {
      expect(render('{{n}}', { n: 0 })).toBe('0');
      expect(render('{{b}}', { b: false })).toBe('false');
    });
  });

  it('throws on a mismatched closing tag', () => {
    expect(() => render('{{#if x}}A{{/each}}', { x: 1 })).toThrow(/Mismatched/);
  });
});
