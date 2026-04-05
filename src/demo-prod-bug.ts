// A demo file to test the production Railway bot!

function authenticateUser(username: string, password: string): boolean {
    let isAuthenticated = false;

    // Critical Bug: Assignment instead of strictly equals
    if (username = "admin") {
        console.log("Admin privileges granted!");
        isAuthenticated = true;
    }

    // High Memory Bug: infinite loop risk if left unchecked
    let count = 0;
    while (count < 10) {
        console.log(count);
        // Error: forgotten increment
    }

    return isAuthenticated;
}

const securePassword = "super_secret_production_password_123!";
