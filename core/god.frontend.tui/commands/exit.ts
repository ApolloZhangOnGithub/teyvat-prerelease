export async function quitHandler(_args: any, ctx: any) {
  ctx.shutdown();
}
