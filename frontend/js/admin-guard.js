(function () {
    'use strict';
    AdminApi.requireAdmin()
        .then(function (user) {
            document.getElementById('admin-loading').hidden = true;
            document.getElementById('admin-content').hidden = false;
            if (user.role === 'admin') {
                document.getElementById('card-audit').hidden = false;
                document.getElementById('card-transactions').hidden = false;
                document.getElementById('card-analytics').hidden = false;
                document.getElementById('card-cars').hidden = false;
                document.getElementById('card-investigation').hidden = false;
            }
            // Initialise Operations Hub dashboard
            AdminDashboard.init(user);
        })
        .catch(function () { /* requireAdmin handles redirects */ });
})();
