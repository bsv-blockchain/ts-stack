export default function styles(theme) {
  return {
    button_grid: {
      display: 'grid',
      gridTemplateColumns: 'auto 1fr auto',
      gridGap: theme.spacing(2)
    }
  }
}
