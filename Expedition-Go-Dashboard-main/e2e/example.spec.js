import { test, expect } from '@playwright/test';

/**
 * Example E2E test
 * This demonstrates basic Playwright usage
 */
test.describe('Dashboard', () => {
  test('should load the dashboard page', async ({ page }) => {
    // Navigate to the dashboard
    await page.goto('/');
    
    // Wait for the page to load
    await page.waitForLoadState('networkidle');
    
    // Check that the page title is correct
    await expect(page).toHaveTitle(/TravioAfrica/i);
    
    // Check that the dashboard heading is visible
    const heading = page.getByRole('heading', { name: /dashboard/i });
    await expect(heading).toBeVisible();
  });

  test('should navigate to bookings page', async ({ page }) => {
    await page.goto('/');
    
    // Click on the bookings link in the sidebar
    await page.click('text=Bookings');
    
    // Wait for navigation
    await page.waitForURL('**/bookings');
    
    // Check that we're on the bookings page
    const heading = page.getByRole('heading', { name: /bookings/i });
    await expect(heading).toBeVisible();
  });
});

test.describe('Navigation', () => {
  test('should navigate through all main pages', async ({ page }) => {
    await page.goto('/');
    
    const pages = [
      { name: 'Bookings', url: '/bookings' },
      { name: 'Products', url: '/products' },
      { name: 'Availability', url: '/availability' },
      { name: 'Performance', url: '/performance' },
      { name: 'Reviews', url: '/reviews' },
      { name: 'Finance', url: '/finance' },
      { name: 'Notifications', url: '/notifications' },
      { name: 'User Management', url: '/users' },
      { name: 'Settings', url: '/settings' },
    ];
    
    for (const { name, url } of pages) {
      // Click on the navigation link
      await page.click(`text=${name}`);
      
      // Wait for navigation
      await page.waitForURL(`**${url}`);
      
      // Check that the page loaded
      await expect(page.getByRole('heading', { name: new RegExp(name, 'i') })).toBeVisible();
    }
  });
});
