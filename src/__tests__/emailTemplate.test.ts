import { renderEmailButton, renderEmailShell } from '../services/emailTemplate';

describe('renderEmailButton', () => {
  const href = 'https://onlyjobs.app/verify-email?token=abc123';
  const label = 'Verify Email';
  let output: string;

  beforeAll(() => {
    output = renderEmailButton(href, label);
  });

  it('contains the href', () => {
    expect(output).toContain(href);
  });

  it('contains the label text', () => {
    expect(output).toContain(label);
  });

  it('uses a presentation table', () => {
    expect(output).toContain('role="presentation"');
    expect(output).toContain('<table');
  });

  it('has bgcolor="#111827" on the td', () => {
    expect(output).toContain('bgcolor="#111827"');
  });

  it('has color:#ffffff on the anchor', () => {
    expect(output).toContain('color:#ffffff');
  });
});

describe('renderEmailShell', () => {
  const innerHtml = '<p>Hello world</p>';
  let output: string;

  beforeAll(() => {
    output = renderEmailShell(innerHtml);
  });

  it('contains the innerHtml', () => {
    expect(output).toContain(innerHtml);
  });

  it('contains a max-width:600px inner table', () => {
    expect(output).toContain('max-width:600px');
  });

  it('contains the MSO conditional comment', () => {
    expect(output).toContain('<!--[if mso]>');
    expect(output).toContain('<![endif]-->');
  });

  it('has word-break:break-word on the content cell', () => {
    expect(output).toContain('word-break:break-word');
  });

  it('has overflow-wrap:anywhere on the content cell', () => {
    expect(output).toContain('overflow-wrap:anywhere');
  });
});
