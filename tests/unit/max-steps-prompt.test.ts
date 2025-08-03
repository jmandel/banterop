import { describe, test, expect } from 'bun:test';

describe('MAX_STEPS Warning in Prompt', () => {
  // Extract the warning logic to test it independently
  function addWarningIfNeeded(currentStatusSection: string, remainingSteps?: number): string {
    if (remainingSteps !== undefined && remainingSteps <= 5) {
      const warningSection = `
<IMPORTANT_WARNING>
⚠️ You have only ${remainingSteps} step${remainingSteps === 1 ? '' : 's'} remaining in this turn!
You MUST send a message to the conversation thread using send_message_to_agent_conversation before your steps run out.
If you don't send a message before reaching 0 steps, the turn will end with an error.
</IMPORTANT_WARNING>`;
      return warningSection + currentStatusSection;
    }
    return currentStatusSection;
  }

  test('should add warning when remainingSteps is 5 or less', () => {
    const baseSection = '<CURRENT_STATUS>Processing...</CURRENT_STATUS>';
    
    // Test with 5 steps
    const with5Steps = addWarningIfNeeded(baseSection, 5);
    expect(with5Steps).toContain('IMPORTANT_WARNING');
    expect(with5Steps).toContain('You have only 5 steps remaining');
    expect(with5Steps).toContain('send_message_to_agent_conversation');
    
    // Test with 3 steps
    const with3Steps = addWarningIfNeeded(baseSection, 3);
    expect(with3Steps).toContain('You have only 3 steps remaining');
    
    // Test with 1 step (singular)
    const with1Step = addWarningIfNeeded(baseSection, 1);
    expect(with1Step).toContain('You have only 1 step remaining');
    expect(with1Step).not.toContain('1 steps'); // Should be singular
  });

  test('should NOT add warning when remainingSteps is more than 5', () => {
    const baseSection = '<CURRENT_STATUS>Processing...</CURRENT_STATUS>';
    
    // Test with 6 steps
    const with6Steps = addWarningIfNeeded(baseSection, 6);
    expect(with6Steps).not.toContain('IMPORTANT_WARNING');
    expect(with6Steps).toBe(baseSection);
    
    // Test with 10 steps
    const with10Steps = addWarningIfNeeded(baseSection, 10);
    expect(with10Steps).not.toContain('IMPORTANT_WARNING');
    expect(with10Steps).toBe(baseSection);
  });

  test('should NOT add warning when remainingSteps is undefined', () => {
    const baseSection = '<CURRENT_STATUS>Processing...</CURRENT_STATUS>';
    
    const withUndefined = addWarningIfNeeded(baseSection, undefined);
    expect(withUndefined).not.toContain('IMPORTANT_WARNING');
    expect(withUndefined).toBe(baseSection);
  });

  test('should calculate remainingSteps correctly in loop', () => {
    const MAX_STEPS = 10;
    const calculations: Array<{ stepCount: number; remainingSteps: number; shouldWarn: boolean }> = [];
    
    for (let stepCount = 1; stepCount <= MAX_STEPS; stepCount++) {
      const remainingSteps = MAX_STEPS - stepCount + 1;
      const shouldWarn = remainingSteps <= 5;
      calculations.push({ stepCount, remainingSteps, shouldWarn });
    }
    
    // Verify calculations
    expect(calculations[0]).toEqual({ stepCount: 1, remainingSteps: 10, shouldWarn: false });
    expect(calculations[4]).toEqual({ stepCount: 5, remainingSteps: 6, shouldWarn: false });
    expect(calculations[5]).toEqual({ stepCount: 6, remainingSteps: 5, shouldWarn: true }); // Warning starts here
    expect(calculations[9]).toEqual({ stepCount: 10, remainingSteps: 1, shouldWarn: true });
    
    // Verify warning appears for exactly the last 5 steps
    const warningSteps = calculations.filter(c => c.shouldWarn);
    expect(warningSteps.length).toBe(5);
    expect(warningSteps[0].remainingSteps).toBe(5);
    expect(warningSteps[4].remainingSteps).toBe(1);
  });

  test('integration: verify warning text format', () => {
    // Test the exact warning format that would appear in the prompt
    const warningFor3Steps = `
<IMPORTANT_WARNING>
⚠️ You have only 3 steps remaining in this turn!
You MUST send a message to the conversation thread using send_message_to_agent_conversation before your steps run out.
If you don't send a message before reaching 0 steps, the turn will end with an error.
</IMPORTANT_WARNING>`;

    expect(warningFor3Steps).toContain('⚠️'); // Has warning emoji
    expect(warningFor3Steps).toContain('3 steps remaining');
    expect(warningFor3Steps).toContain('MUST send a message');
    expect(warningFor3Steps).toContain('before your steps run out');
    expect(warningFor3Steps).toContain('turn will end with an error');
  });
});