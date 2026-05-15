/**
 * ALIGNED — Theme object for Styled-components, Emotion, MUI v5+.
 *
 * Usage (Styled-components / Emotion):
 *
 *   import { ThemeProvider } from 'styled-components';
 *   import { alignedTheme } from './theme';
 *
 *   <ThemeProvider theme={alignedTheme}><App /></ThemeProvider>
 *
 * Usage (MUI v5+):
 *
 *   import { createTheme, ThemeProvider } from '@mui/material';
 *   import { alignedTheme as t } from './theme';
 *
 *   const muiTheme = createTheme({
 *     palette: { primary: { main: t.colors.primary }, ... },
 *     shape:   { borderRadius: 14 },
 *     typography: { fontFamily: t.fonts.body },
 *   });
 */

export const alignedTheme = {
  colors: {
    bg:        '#F4F2F8',
    bg2:       '#ECE9F4',
    surface:   '#FFFFFF',
    surface2:  '#FAF9FD',

    primary:     '#7C6BFF',
    primary600:  '#6856E8',
    primary700:  '#5546D9',
    primary100:  '#EEEAFF',
    primary200:  '#DCD4FF',

    coral:       '#FF8A6B',
    coral600:    '#F37454',
    coral100:    '#FFE5DC',

    yellow:      '#FFD66B',
    yellow100:   '#FFF3D1',

    green:       '#5BC97A',
    green100:    '#D8F2DE',

    red:         '#FF6B7C',
    red100:      '#FFE0E4',

    text:    '#1A1828',
    text2:   '#3D3950',
    muted:   '#6B6880',
    mute2:   '#9C99B0',

    border:  '#ECE9F4',
    border2: '#DDD8EA',
  },

  radii: {
    xs:   '8px',
    sm:   '14px',
    md:   '20px',
    lg:   '28px',
    xl:   '36px',
    pill: '999px',
  },

  shadows: {
    sm:      '0 1px 2px rgba(40, 30, 80, 0.04), 0 2px 8px rgba(40, 30, 80, 0.04)',
    md:      '0 4px 16px rgba(40, 30, 80, 0.06), 0 1px 3px rgba(40, 30, 80, 0.04)',
    lg:      '0 14px 40px rgba(40, 30, 80, 0.08), 0 4px 12px rgba(40, 30, 80, 0.04)',
    primary: '0 10px 26px rgba(124, 107, 255, 0.30)',
    coral:   '0 10px 26px rgba(255, 138, 107, 0.30)',
  },

  fonts: {
    body: "'Plus Jakarta Sans', -apple-system, BlinkMacSystemFont, system-ui, sans-serif",
    mono: "'JetBrains Mono', ui-monospace, SFMono-Regular, monospace",
  },

  space: { 1: '4px', 2: '8px', 3: '12px', 4: '16px', 5: '20px', 6: '24px', 8: '32px', 10: '40px', 12: '48px' },
} as const;

export type AlignedTheme = typeof alignedTheme;
