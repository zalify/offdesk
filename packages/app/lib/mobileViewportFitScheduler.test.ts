import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMobileViewportFitScheduler } from './mobileViewportFitScheduler';
afterEach(()=>vi.useRealTimers());
function setup() {
  vi.useFakeTimers();
  const fit=vi.fn(); const canFit=vi.fn(()=>true);
  const scheduler=createMobileViewportFitScheduler({canFit,fit,schedule:setTimeout,cancel:clearTimeout});
  scheduler.observe({width:390,height:700});
  return {scheduler,fit,canFit};
}
describe('mobile container fitting',()=>{
  it('waits for the final keyboard and fixed-toolbar layout without fitting on mount',()=>{
    const {scheduler,fit}=setup();vi.advanceTimersByTime(200);expect(fit).not.toHaveBeenCalled();
    scheduler.observe({width:390,height:420});vi.advanceTimersByTime(100);
    scheduler.observe({width:390,height:360});vi.advanceTimersByTime(149);expect(fit).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);expect(fit).toHaveBeenCalledTimes(1);
    scheduler.observe({width:390,height:360});vi.advanceTimersByTime(200);expect(fit).toHaveBeenCalledTimes(1);
  });
  it('responds to fixed UI changes even when the window does not resize, and restores height',()=>{
    const {scheduler,fit}=setup();scheduler.observe({width:390,height:560});vi.advanceTimersByTime(150);
    scheduler.observe({width:390,height:700});vi.advanceTimersByTime(150);expect(fit).toHaveBeenCalledTimes(2);
  });
  it('does not resize viewers or inactive panes and rechecks control before firing',()=>{
    const {scheduler,fit,canFit}=setup();canFit.mockReturnValue(false);
    scheduler.observe({width:390,height:420});vi.advanceTimersByTime(200);expect(fit).not.toHaveBeenCalled();
    canFit.mockReturnValue(true);scheduler.observe({width:390,height:400});canFit.mockReturnValue(false);
    vi.advanceTimersByTime(200);expect(fit).not.toHaveBeenCalled();
  });
  it('cancels pending fits on hidden containers and unmount',()=>{
    const {scheduler,fit}=setup();scheduler.observe({width:390,height:420});scheduler.observe({width:0,height:0});
    vi.advanceTimersByTime(200);expect(fit).not.toHaveBeenCalled();
    scheduler.observe({width:390,height:700});scheduler.observe({width:390,height:420});scheduler.dispose();
    vi.advanceTimersByTime(200);scheduler.observe({width:390,height:300});vi.advanceTimersByTime(200);expect(fit).not.toHaveBeenCalled();
  });
});
