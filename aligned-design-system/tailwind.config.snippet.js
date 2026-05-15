/**
 * ALIGNED — Tailwind theme extension
 *
 * In your tailwind.config.js:
 *
 *   const aligned = require('./tailwind.config.snippet.js');
 *
 *   module.exports = {
 *     theme: {
 *       extend: {
 *         ...aligned.theme.extend,
 *       },
 *     },
 *   };
 *
 * Then use classes like `bg-al-primary`, `text-al-muted`, `rounded-al-lg`,
 * `shadow-al-primary`, etc.
 */

module.exports = {
  theme: {
    extend: {
      colors: {
        'al-bg':           '#F4F2F8',
        'al-bg-2':         '#ECE9F4',
        'al-surface':      '#FFFFFF',
        'al-surface-2':    '#FAF9FD',

        'al-primary':      '#7C6BFF',
        'al-primary-600':  '#6856E8',
        'al-primary-700':  '#5546D9',
        'al-primary-100':  '#EEEAFF',
        'al-primary-200':  '#DCD4FF',

        'al-coral':        '#FF8A6B',
        'al-coral-600':    '#F37454',
        'al-coral-100':    '#FFE5DC',

        'al-yellow':       '#FFD66B',
        'al-yellow-100':   '#FFF3D1',

        'al-green':        '#5BC97A',
        'al-green-100':    '#D8F2DE',

        'al-red':          '#FF6B7C',
        'al-red-100':      '#FFE0E4',

        'al-text':         '#1A1828',
        'al-text-2':       '#3D3950',
        'al-muted':        '#6B6880',
        'al-mute-2':       '#9C99B0',

        'al-border':       '#ECE9F4',
        'al-border-2':     '#DDD8EA',
      },
      borderRadius: {
        'al-xs':   '8px',
        'al-sm':   '14px',
        'al-md':   '20px',
        'al-lg':   '28px',
        'al-xl':   '36px',
        'al-pill': '999px',
      },
      boxShadow: {
        'al-sm':      '0 1px 2px rgba(40, 30, 80, 0.04), 0 2px 8px rgba(40, 30, 80, 0.04)',
        'al':         '0 4px 16px rgba(40, 30, 80, 0.06), 0 1px 3px rgba(40, 30, 80, 0.04)',
        'al-lg':      '0 14px 40px rgba(40, 30, 80, 0.08), 0 4px 12px rgba(40, 30, 80, 0.04)',
        'al-primary': '0 10px 26px rgba(124, 107, 255, 0.30)',
        'al-coral':   '0 10px 26px rgba(255, 138, 107, 0.30)',
      },
      fontFamily: {
        'al':      ['"Plus Jakarta Sans"', 'system-ui', 'sans-serif'],
        'al-mono': ['"JetBrains Mono"', 'ui-monospace', 'monospace'],
      },
      letterSpacing: {
        'al-tight': '-0.025em',
        'al-snug':  '-0.015em',
      },
    },
  },
};
