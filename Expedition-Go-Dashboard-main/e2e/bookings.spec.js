import { test, expect } from '@playwright/test';

/**
 * E2E tests for Bookings page
 */
test.describe('Bookings Page', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/bookings');
    await page.waitForLoadState('networkidle');
  });

  test('should display bookings table', async ({ page }) => {
    // Check that the page heading is visible
    const heading = page.getByRole('heading', { name: /bookings/i });
    await expect(heading).toBeVisible();
    
    // Check that the table or empty state is visible
    const table = page.locator('table');
    const emptyState = page.getByText(/no bookings/i);
    
    // Either table or empty state should be visible
    const tableVisible = await table.isVisible().catch(() => false);
    const emptyStateVisible = await emptyState.isVisible().catch(() => false);
    
    expect(tableVisible || emptyStateVisible).toBe(true);
  });

  test('should filter bookings by status', async ({ page }) => {
    // Click on the status filter button
    const statusButton = page.getByRole('button', { name: /status/i });
    await statusButton.click();
    
    // Wait for dropdown to appear
    await page.waitForSelector('text=Confirmed', { timeout: 5000 });
    
    // Select a status filter
    await page.click('text=Confirmed');
    
    // Check that the filter is applied (URL should update)
    await page.waitForURL('**/bookings?*status=CONFIRMED*');
  });

  test('should search for bookings', async ({ page }) => {
    // Find the search input
    const searchInput = page.getByPlaceholder(/search/i);
    await expect(searchInput).toBeVisible();
    
    // Type in the search box
    await searchInput.fill('John');
    
    // Press Enter or wait for debounce
    await searchInput.press('Enter');
    
    // Check that URL updates with search query
    await page.waitForURL('**/bookings?*search=*');
  });

  test('should change page size', async ({ page }) => {
    // Find the page size selector
    const pageSizeSelect = page.locator('select').first();
    
    if (await pageSizeSelect.isVisible()) {
      // Change page size
      await pageSizeSelect.selectOption('50');
      
      // Check that URL updates
      await page.waitForURL('**/bookings?*pageSize=50*');
    }
  });

  test('should navigate between quick filter tabs', async ({ page }) => {
    // Click on "Awaiting Confirmation" tab
    const awaitingTab = page.getByRole('button', { name: /awaiting confirmation/i });
    
    if (await awaitingTab.isVisible()) {
      await awaitingTab.click();
      
      // Check that URL updates
      await page.waitForURL('**/bookings?*status=AWAITING_CONFIRMATION*');
    }
  });

  test('should clear all filters', async ({ page }) => {
    // Apply some filters first
    const searchInput = page.getByPlaceholder(/search/i);
    await searchInput.fill('test');
    await searchInput.press('Enter');
    
    // Wait for filters to be applied
    await page.waitForURL('**/bookings?*search=*');
    
    // Click clear filters button
    const clearButton = page.getByRole('button', { name: /clear/i });
    
    if (await clearButton.isVisible()) {
      await clearButton.click();
      
      // Check that URL is reset
      await page.waitForURL('/bookings');
    }
  });
});
