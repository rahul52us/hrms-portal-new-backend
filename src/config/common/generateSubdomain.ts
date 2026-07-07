const { Builder, By, until } = require('selenium-webdriver');

export async function createSubdomain() {
    // Initialize the WebDriver
    const driver = await new Builder().forBrowser('chrome').build();
    try {
        // Step 1: Navigate to the Hostinger login page
        await driver.get('https://www.hostinger.com/login');

        // Step 2: Wait for the email input field to be visible and enter your email
        await driver.wait(until.elementLocated(By.css('input[name="email"]')), 10000).sendKeys('rahul52us@gmail.com'); // Replace with your email

        // Step 3: Wait for the password input field to be visible and enter your password
        await driver.wait(until.elementLocated(By.css('input[name="password"]')), 10000).sendKeys('your_password'); // Replace with your password

        // Step 4: Click the submit button
        await driver.wait(until.elementLocated(By.css('button[type="submit"]')), 10000).click();

        // Step 5: Wait for the dashboard to load
        await driver.wait(until.titleIs('Hostinger Dashboard'), 10000);

        // Step 6: Navigate to the "Websites" section
        await driver.wait(until.elementLocated(By.linkText('Websites')), 10000).click();

        // Step 7: Click "Manage" next to your domain
        await driver.wait(until.elementLocated(By.xpath("//div[contains(text(), 'Manage')]")), 10000).click();

        // Step 8: Click on "Connect Domain"
        await driver.wait(until.elementLocated(By.linkText('Connect Domain')), 10000).click();

        // Step 9: Choose "Use an Existing Domain"
        await driver.wait(until.elementLocated(By.xpath("//button[contains(text(), 'Use an Existing Domain')]")), 10000).click();

        // Step 10: Enter the desired subdomain
        await driver.wait(until.elementLocated(By.name('subdomain')), 10000).sendKeys('rahul'); // Replace with your desired subdomain

        // Step 11: Click the "Continue" button
        await driver.wait(until.elementLocated(By.css('button[type="submit"]')), 10000).click();

        // Step 12: Wait for confirmation of the subdomain creation
        await driver.wait(until.elementLocated(By.css('.success-message')), 10000);
        console.log('Subdomain created successfully!');

    } catch (error) {
        console.error('An error occurred:', error);
    } finally {
        await driver.quit(); // Close the browser
    }
}
