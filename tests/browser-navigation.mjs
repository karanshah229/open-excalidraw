/** Simulate choosing Leave for a deliberate reload while cloud writes are pending. */
export async function reloadAllowingPendingChanges(page, options) {
  let unexpectedDialog
  const onDialog = async (dialog) => {
    if (dialog.type() !== 'beforeunload') {
      unexpectedDialog = new Error(`Unexpected ${dialog.type()} dialog during deliberate reload`)
      await dialog.dismiss()
      return
    }
    console.log('Accepted pending-change warning for deliberate reload')
    await dialog.accept()
  }
  page.on('dialog', onDialog)
  try {
    await page.reload(options)
    if (unexpectedDialog) throw unexpectedDialog
  } finally {
    page.off('dialog', onDialog)
  }
}
