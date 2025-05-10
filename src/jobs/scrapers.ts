import axios from "axios";
import { BasicAcceptedElems, load } from "cheerio";
import puppeteer, { Browser } from "puppeteer";

// Common interface for all scraped jobs
export interface ScrapedJob {
  title: string;
  company: string;
  location: string[];
  description?: string;
  url: string;
  tags?: string[];
  source: string;
  salary?: {
    min?: number;
    max?: number;
    estimated?: boolean; // Indicates if the salary is estimated
    currency?: string;
  };
  postedDate?: Date;
  scrapedDate?: Date; // Added field for tracking when job was scraped
}

/**
 * Scrapes jobs from landing.jobs
 */
export async function scrapeLandingJobs(url?: string): Promise<ScrapedJob[]> {
  let page = 1;
  const allJobs: ScrapedJob[] = [];

  while (true) {
    try {
      // Construct the URL for the current page
      url = `https://landing.jobs/jobs/search.json?page=${page}&match=all&country=&hd=false&t_co=false&t_st=false`;

      // Fetch the page JSON data
      const { data } = await axios.get(url, {
        headers: {
          accept: "application/json, text/javascript, */*; q=0.01",
          "User-Agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36 OPR/117.0.0.0",
          "x-csrf-token":
            "cb6c8mOO3NC93hQ9ta3OtCvW/qroT9EhAVKDF7j58yRhjLYegrc5NXbRHvlhR3WUVUu5jmCATyfy8rBgw+c/lg==",
        },
      });

      // Check if we have any job offers
      const offers = data.offers;
      if (!offers || offers.length === 0) {
        break; // No more jobs found, stop pagination
      }

      // Loop through each job and add it to the result
      for (const offer of offers) {
        // Extract the basic details for the job
        const job = {
          title: offer.title,
          company: offer.company_name,
          location: [offer.location || "Remote"],
          url: offer.url,
          source: "landing.jobs",
          postedDate: new Date(offer.published_at),
          scrapedDate: new Date(),
          description: "", // Placeholder, will update this later
          tags: offer.skills.map((skill: any) => skill.name),
        };

        // Fetch the detailed job page to extract additional data
        const jobPageData = await fetchJobDetails(job.url);

        // Merge the detailed data with the basic job data
        if (jobPageData) {
          job.description = jobPageData.description;
        }

        // Add the job to the result list
        allJobs.push(job);
      }

      page += 1; // Move to the next page if there are more jobs
    } catch (error) {
      console.error("Error fetching landing.jobs API:", error);
      break;
    }
  }

  console.log(`Scraped ${allJobs.length} jobs from landing.jobs`);
  return allJobs;
}

/**
 * Fetches the detailed job data from the individual job page.
 */
async function fetchJobDetails(url: string) {
  try {
    // Fetch the HTML content of the job detail page
    const { data } = await axios.get(url, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; JobScraper/1.0)" },
    });

    // Load the page HTML into Cheerio
    const $ = load(data);

    // Extract the second ld+json block containing the detailed job posting data
    const jsonLdScript = $('script[type="application/ld+json"]').eq(1).html();

    if (jsonLdScript) {
      const jobData = JSON.parse(jsonLdScript);

      // Extract relevant details from the JSON-LD data
      return {
        description: jobData.description || "",
        skills: jobData.skills || [],
        experience: jobData.experienceRequirements
          ? jobData.experienceRequirements.monthsOfExperience
          : null,
        jobType: jobData.employmentType || "",
      };
    } else {
      throw new Error("Detailed job data not found");
    }
  } catch (error) {
    console.error(`Error fetching job details for URL ${url}:`, error);
    return null;
  }
}

/**
 * Scrapes jobs from WeWorkRemotely
 * HTML-based scraper
 */
export async function scrapeWeWorkRemotely(url: string): Promise<ScrapedJob[]> {
  const browser = await puppeteer.launch({ headless: true });
  const page = await browser.newPage();

  try {
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
    );
    await page.goto(url, { waitUntil: "networkidle2" });

    const jobLinks = await page.evaluate(() => {
      const results: {
        title: string;
        company: string;
        location: string;
        url: string;
        tags: string[];
        postedAt?: string;
      }[] = [];

      const listings = document.querySelectorAll(
        "section.jobs li.new-listing-container"
      );

      listings.forEach((el) => {
        const anchor = el.querySelectorAll("a")[1];
        const rawHref = anchor?.getAttribute("href") || "";
        if (!rawHref.startsWith("/remote-jobs/")) return;

        const jobURL = `https://weworkremotely.com${rawHref}`;
        const title =
          el
            .querySelector("h4.new-listing__header__title")
            ?.textContent?.trim() || "";
        const company =
          el
            .querySelector("p.new-listing__company-name")
            ?.textContent?.trim() || "";
        const location =
          el
            .querySelector("p.new-listing__company-headquarters")
            ?.textContent?.trim() || "Remote";

        const tags: string[] = [];
        el.querySelectorAll(".new-listing__categories__category").forEach(
          (tagEl: Element | HTMLElement) => {
            const tag = tagEl.textContent?.trim();
            if (tag) tags.push(tag);
          }
        );

        const postedAtText =
          el
            .querySelector(".new-listing__header__icons__date")
            ?.textContent?.trim() || "";
        let postedAt: string | undefined = undefined;
        const daysAgo = parseInt(postedAtText.replace(/[^\d]/g, ""), 10);
        if (!isNaN(daysAgo)) {
          const date = new Date(Date.now() - daysAgo * 86400000);
          postedAt = date.toISOString();
        }

        if (title && company) {
          results.push({
            title,
            company,
            location,
            url: jobURL,
            tags,
            postedAt,
          });
        }
      });

      return results;
    });

    const jobs: ScrapedJob[] = [];

    for (const job of jobLinks) {
      try {
        const jobPage = await browser.newPage();
        await jobPage.goto(job.url, { waitUntil: "networkidle2" });

        const description = await jobPage.evaluate(() => {
          const blocks: string[] = [];
          document
            .querySelectorAll(
              ".lis-container__job__content__description div, p, li"
            )
            .forEach((el: Element | HTMLElement) => {
              const text = el.textContent?.trim();
              if (text) blocks.push(text);
            });

          return blocks.join("\n");
        });

        if (!description) {
          console.warn("Missing description for", job.url);
          continue;
        }

        jobs.push({
          ...job,
          description,
          location: job.location.includes(",")
            ? job.location.split(",").map((l: string) => l.trim())
            : [job.location],
          source: "WeWorkRemotely",
          scrapedDate: new Date(),
        });

        await jobPage.close();
      } catch (err) {
        console.warn("Failed to extract job detail from", job.url, err);
      }
    }

    console.log(
      `Scraped ${jobs.length} jobs from WeWorkRemotely with Puppeteer`
    );
    return jobs;
  } catch (err) {
    console.error("WWR Puppeteer scrape error:", err);
    return [];
  } finally {
    await browser.close();
  }
}

/**
 * Scrapes jobs from Remotive using Puppeteer
 * doesn't work atm
 */
export async function scrapeRemotive(): Promise<ScrapedJob[]> {
  const browser = await puppeteer.launch({ headless: true });
  const page = await browser.newPage();
  const jobs: ScrapedJob[] = [];

  try {
    // Set user agent to avoid detection
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
    );

    // Navigate to Remotive jobs page
    await page.goto("https://remotive.com/remote-jobs/software-dev", {
      waitUntil: "networkidle2",
      timeout: 60000,
    });

    // Extract job listings
    const jobLinks = await page.evaluate(() => {
      const results: {
        title: string;
        company: string;
        location: string;
        url: string;
        tags: string[];
        postedAtText: string;
      }[] = [];

      // Select all job listing elements
      const listings = document.querySelectorAll(".job-tile");

      listings.forEach((el) => {
        // Extract basic job information
        const titleEl = el.querySelector(".position, .job-title");
        const companyEl = el.querySelector(".company, .company-name");
        const locationEl = el.querySelector(".location, .job-location");
        const linkEl = el.querySelector("a.job-link, a.position-link");

        if (!titleEl || !companyEl || !linkEl) return;

        const title = titleEl.textContent?.trim() || "";
        const company = companyEl.textContent?.trim() || "";
        const location = locationEl?.textContent?.trim() || "Remote";
        const url = linkEl.getAttribute("href") || "";

        // Extract tags if available
        const tags: string[] = [];
        el.querySelectorAll(".tags span, .job-tags .tag").forEach((tagEl) => {
          const tag = tagEl.textContent?.trim();
          if (tag) tags.push(tag);
        });

        // Extract posted date text
        const postedAtText =
          el.querySelector(".job-date, .posted-date")?.textContent?.trim() ||
          "";

        if (title && company && url) {
          results.push({
            title,
            company,
            location,
            url: url.startsWith("http") ? url : `https://remotive.com${url}`,
            tags,
            postedAtText,
          });
        }
      });

      return results;
    });

    // Visit each job page to get the full description
    for (const job of jobLinks) {
      try {
        const jobPage = await browser.newPage();
        await jobPage.goto(job.url, {
          waitUntil: "networkidle2",
          timeout: 30000,
        });

        // Extract job description
        const description = await jobPage.evaluate(() => {
          const descriptionEl = document.querySelector(
            ".job-description, .description"
          );
          return descriptionEl ? descriptionEl.textContent?.trim() || "" : "";
        });

        // Parse the posted date text into a Date object
        let postedDate: Date | undefined = undefined;
        if (job.postedAtText) {
          // Handle different date formats like "Posted 2 days ago", "Jun 15, 2025", etc.
          if (
            job.postedAtText.includes("day") ||
            job.postedAtText.includes("hour")
          ) {
            const daysMatch = job.postedAtText.match(/(\d+)\s*day/);
            const hoursMatch = job.postedAtText.match(/(\d+)\s*hour/);

            const daysAgo = daysMatch ? parseInt(daysMatch[1], 10) : 0;
            const hoursAgo = hoursMatch ? parseInt(hoursMatch[1], 10) : 0;

            postedDate = new Date();
            postedDate.setDate(postedDate.getDate() - daysAgo);
            postedDate.setHours(postedDate.getHours() - hoursAgo);
          } else {
            try {
              postedDate = new Date(job.postedAtText);
            } catch (e) {
              // Invalid date format, ignore
            }
          }
        }

        jobs.push({
          title: job.title,
          company: job.company,
          location: Array.isArray(job.location) ? job.location : [job.location],
          description,
          url: job.url,
          tags: job.tags,
          source: "Remotive",
          postedDate,
          scrapedDate: new Date(),
        });

        await jobPage.close();
      } catch (err) {
        console.warn("Failed to extract job details from", job.url, err);
      }
    }

    console.log(`Scraped ${jobs.length} jobs from Remotive with Puppeteer`);
    return jobs;
  } catch (error) {
    console.error("Error scraping Remotive with Puppeteer:", error);
    return [];
  } finally {
    await browser.close();
  }
}

/**
 * Scrapes jobs from RemoteOK
 * JSON API-based scraper
 */
export async function scrapeRemoteOK(): Promise<ScrapedJob[]> {
  try {
    // RemoteOK API requires a User-Agent header
    const url = "https://remoteok.com/api";
    const response = await axios.get(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; JobBoardScraper/1.0)",
      },
    });

    // The first item is usually not a job but information about the API
    const jobsData = Array.isArray(response.data) ? response.data.slice(1) : [];

    const jobs: ScrapedJob[] = jobsData.map((job: any) => ({
      title: job.position || "Unknown Position",
      company: job.company || "Unknown Company",
      location: job.location || "Remote",
      description: job.description,
      url: job.url.startsWith("http")
        ? job.url
        : `https://remoteok.com${job.url}`,
      tags:
        job.tags?.length > 0
          ? job.tags.map((tag: string) => tag.toLowerCase().trim())
          : [],
      source: "RemoteOK",
      postedAt: job.date ? new Date(job.date).toISOString() : undefined,
      scrapedDate: new Date(), // Set the scraped date to the current date
    }));

    console.log(`Scraped ${jobs.length} jobs from RemoteOK`);
    return jobs;
  } catch (error) {
    console.error("Error scraping RemoteOK:", error);
    return [];
  }
}

/**
 * Scrapes jobs from JSRemotely
 * HTML-based scraper
 */
export async function scrapeJSRemotely(): Promise<ScrapedJob[]> {
  try {
    const url = "https://jsremotely.com/remote-javascript-jobs";
    const response = await axios.get(url);
    const $ = load(response.data);
    const jobs: ScrapedJob[] = [];

    // JSRemotely typically has job listings in card-like structures
    $(".job-card, .job-listing, .job-item").each(
      (_: number, element: BasicAcceptedElems<any>) => {
        const title = $(element)
          .find(".job-title, h2, h3")
          .first()
          .text()
          .trim();
        const company = $(element)
          .find(".company-name, .company")
          .first()
          .text()
          .trim();
        const locationElement = $(element).find(".location, .job-location");
        const location = locationElement.length
          ? locationElement.text().trim()
          : "Remote";

        // Extract job URL
        const jobURL = $(element).find("a").attr("href") || "";
        const fullURL = jobURL.startsWith("http")
          ? jobURL
          : `https://jsremotely.com${jobURL}`;

        // Extract tags if available
        const tags: string[] = [];
        $(element)
          .find(".tags .tag, .skills span")
          .each((_: number, tagElement: BasicAcceptedElems<any>) => {
            tags.push($(tagElement).text().trim());
          });

        // Try to find posted date
        const postedAtText = $(element)
          .find(".date, .posted-date, .job-date")
          .text()
          .trim();
        let postedAt: Date | undefined = undefined;

        if (postedAtText) {
          try {
            postedAt = new Date(postedAtText);
          } catch (e) {
            // Invalid date format, ignore
          }
        }

        if (title && company && fullURL) {
          jobs.push({
            title,
            company,
            location: location.includes(",") ? location.split(",") : [location],
            url: fullURL,
            tags,
            source: "JSRemotely",
            postedDate: postedAt,
            scrapedDate: new Date(), // Set the scraped date to the current date
          });
        }
      }
    );

    console.log(`Scraped ${jobs.length} jobs from JSRemotely`);
    return jobs;
  } catch (error) {
    console.error("Error scraping JSRemotely:", error);
    return [];
  }
}

/**
 * Scrapes jobs from ReactJobsBoard
 * HTML-based scraper
 */
export async function scrapeReactJobsBoard(): Promise<ScrapedJob[]> {
  try {
    const url = "https://reactjobsboard.com/remote-react-jobs";
    const response = await axios.get(url);
    const $ = load(response.data);
    const jobs: ScrapedJob[] = [];

    // ReactJobsBoard typically has a structure of job cards
    $(".job-card, .job-item, article").each(
      (_: number, element: BasicAcceptedElems<any>) => {
        const title = $(element)
          .find(".job-title, h2, h3")
          .first()
          .text()
          .trim();
        const company = $(element)
          .find(".company-name, .company")
          .first()
          .text()
          .trim();
        const location = $(element).find(".location").text().trim() || "Remote";

        // Get job URL
        let jobURL = $(element).find("a").attr("href");
        // Ensure the URL is absolute
        if (jobURL && !jobURL.startsWith("http")) {
          jobURL = `https://reactjobsboard.com${jobURL}`;
        }

        // Extract tags
        const tags: string[] = [];
        $(element)
          .find(".tag, .skill, .technology")
          .each((_: number, tagEl: BasicAcceptedElems<any>) => {
            const tag = $(tagEl).text().trim();
            if (tag) tags.push(tag);
          });

        // Extract posted date if available
        const dateText = $(element).find(".date, .posted").text().trim();
        let postedAt: Date | undefined = undefined;

        if (dateText) {
          try {
            postedAt = new Date(dateText);
          } catch (e) {
            // Invalid date format
          }
        }

        if (title && company && jobURL) {
          jobs.push({
            title,
            company,
            location: location.includes(",") ? location.split(",") : [location],
            url: jobURL,
            tags,
            source: "ReactJobsBoard",
            postedDate: postedAt,
            scrapedDate: new Date(), // Set the scraped date to the current date
          });
        }
      }
    );

    console.log(`Scraped ${jobs.length} jobs from ReactJobsBoard`);
    return jobs;
  } catch (error) {
    console.error("Error scraping ReactJobsBoard:", error);
    return [];
  }
}

/**
 * Scrapes jobs from NoDesk
 * HTML-based scraper
 */
export async function scrapeNoDesk(url: string): Promise<ScrapedJob[]> {
  try {
    const response = await axios.get(url);
    const $ = load(response.data);
    const jobs: ScrapedJob[] = [];

    // Find job listings by targeting dt-s dt-ns elements that contain job data
    console.log("Examining NoDesk HTML structure...");

    // The actual job listings appear to be in li elements inside a ul with class "list"
    $("ul.list > li.dt-s, li.dt-s.dt-ns").each((_, element) => {
      try {
        // Extract job title from h2 elements
        const titleElement = $(element)
          .find("h2.f8.f7-ns.fw6.lh-title a, h2 a")
          .first();
        const title = titleElement.text().trim();

        // Extract company name
        const companyElement = $(element)
          .find("h3.f8.fw4 a, h3.f8.fw4")
          .first();
        let company = companyElement.text().trim();

        // If company is empty, try alternative selector
        if (!company) {
          company = $(element).find("h3").text().trim();
        }

        // Extract locations
        const locationItems: string[] = [];
        $(element)
          .find("h5.f9.fw4 a, h5.f9.fw4.grey-700.mv0, h5.f9.fw4.grey-900.mv0")
          .each((_, locElement) => {
            const loc = $(locElement).text().trim();
            if (loc && loc !== "Remote:" && !locationItems.includes(loc)) {
              locationItems.push(loc);
            }
          });

        // Extract job URL
        const jobURL = titleElement.attr("href");
        const fullJobURL = jobURL?.startsWith("http")
          ? jobURL
          : `https://nodesk.co${jobURL}`;

        // Extract job categories/tags
        const tags: string[] = [];
        $(element)
          .find("ul.list.f10 li.dib a, ul.list.f10 li.dib span")
          .each((_, tagEl) => {
            const tag = $(tagEl).text().trim();
            if (tag && !tags.includes(tag)) {
              tags.push(tag);
            }
          });

        // Extract job type (Full-Time, etc.)
        $(element)
          .find("h4.f9.fw4.mv0 a")
          .each((_, jobTypeEl) => {
            const jobType = $(jobTypeEl).text().trim();
            if (jobType && !tags.includes(jobType)) {
              tags.push(jobType);
            }
          });

        // Extract salary if available
        const salaryText = $(element)
          .find("h4.f9.grey-900.fw4.mv0, h4.f9.grey-700.fw4.mv0")
          .text()
          .trim();

        let salary = undefined;

        if (salaryText && salaryText.includes("$")) {
          // Check for salary ranges like "$7.2K – $24K"
          const salaryMatch = salaryText.match(
            /\$(\d+(?:\.\d+)?)K\s*[–-]\s*\$(\d+(?:\.\d+)?)K/
          );
          if (salaryMatch) {
            salary = {
              min: parseFloat(salaryMatch[1]) * 1000,
              max: parseFloat(salaryMatch[2]) * 1000,
              currency: "USD",
              estimated: true,
            };
          } else {
            // Check for single salary like "$5K"
            const singleSalaryMatch = salaryText.match(/\$(\d+(?:\.\d+)?)K/);
            if (singleSalaryMatch) {
              const amount = parseFloat(singleSalaryMatch[1]) * 1000;
              salary = {
                min: amount,
                max: amount,
                currency: "USD",
                estimated: true,
              };
            }
          }
        }

        // Extract posted date
        const dateElement = $(element).find("time");
        let dateText = dateElement.attr("datetime");

        if (!dateText) {
          dateText =
            $(element).find("span.f9 time").text().trim() ||
            $(element).find(".dtc-ns.f9.grey-700.tr.v-top span").text().trim();
        }

        let postedDate: Date | undefined = undefined;

        if (dateText) {
          if (dateText.toLowerCase().includes("today")) {
            postedDate = new Date();
          } else if (dateText.includes("d")) {
            // Handle "1d", "2d" format
            const daysAgo = parseInt(dateText.replace(/\D/g, ""), 10);
            if (!isNaN(daysAgo)) {
              postedDate = new Date();
              postedDate.setDate(postedDate.getDate() - daysAgo);
            }
          } else {
            try {
              postedDate = new Date(dateText);
            } catch (e) {
              console.log("Could not parse date:", dateText);
            }
          }
        }

        if (title && company && fullJobURL) {
          // Create basic job information first
          const job: ScrapedJob = {
            title,
            company,
            location: locationItems.length > 0 ? locationItems : ["Remote"],
            url: fullJobURL,
            tags,
            source: "NoDesk",
            salary,
            postedDate,
            scrapedDate: new Date(),
          };

          // Add to jobs array to be processed for detailed information
          jobs.push(job);
          console.log(`Found job: ${title} at ${company}`);
        }
      } catch (err) {
        console.error("Error parsing NoDesk job item:", err);
      }
    });

    if (jobs.length === 0) {
      console.log(
        "No jobs found with primary selector, trying alternative selector"
      );

      // Try another selector pattern based on the featured jobs
      $("li.dt-s.dt-ns.bt.b--indigo-100, li.dt-s.dt-ns.bt.b--indigo-050").each(
        (_, element) => {
          try {
            const titleElement = $(element).find("h2 a").first();
            const title = titleElement.text().trim();

            const companyElement = $(element).find("h3").first();
            const company = companyElement.text().trim();

            // Extract job URL
            const jobURL = titleElement.attr("href");
            const fullJobURL = jobURL?.startsWith("http")
              ? jobURL
              : `https://nodesk.co${jobURL}`;

            // Extract tags if available (simplified)
            const tags: string[] = [];
            $(element)
              .find("ul.list li.dib a, ul.list li.dib span")
              .each((_, tagEl) => {
                const tag = $(tagEl).text().trim();
                if (tag && !tags.includes(tag)) {
                  tags.push(tag);
                }
              });

            if (title && company && fullJobURL) {
              // We found a job with minimum required info
              jobs.push({
                title,
                company,
                location: ["Remote"], // Default
                url: fullJobURL,
                tags,
                source: "NoDesk",
                scrapedDate: new Date(),
              });

              console.log(
                `Found job with alternative selector: ${title} at ${company}`
              );
            }
          } catch (err) {
            console.error("Error with alternative selector:", err);
          }
        }
      );
    }

    console.log(
      `Found ${jobs.length} jobs on NoDesk listing page. Fetching detailed information...`
    );

    // Process each job to get detailed information
    const detailedJobs: ScrapedJob[] = [];

    for (let i = 0; i < jobs.length; i++) {
      const job = jobs[i];

      try {
        console.log(
          `Fetching details for job ${i + 1}/${jobs.length}: ${job.title}`
        );
        const jobDetails = await fetchNoDeskJobDetails(job.url);

        // Merge job details with the basic job info
        const detailedJob: ScrapedJob = {
          ...job,
          description: jobDetails.description || "",
          // Add any additional tags found on the detail page
          tags: [
            ...new Set([
              ...(job.tags || []),
              ...(jobDetails.additionalTags || []),
            ]),
          ],
          // Update salary if found on detail page and not already set
          salary: job.salary || jobDetails.salary,
        };

        // Update the URL to the actual application URL if found
        if (jobDetails.applicationUrl) {
          detailedJob.url = jobDetails.applicationUrl;
        }

        detailedJobs.push(detailedJob);

        // Add a small delay to avoid overwhelming the server
        await new Promise((resolve) => setTimeout(resolve, 500));
      } catch (error) {
        console.error(`Error fetching details for job ${job.title}:`, error);
        detailedJobs.push(job); // Add the job without details if there's an error
      }
    }

    console.log(
      `Successfully scraped ${detailedJobs.length} jobs from NoDesk with details`
    );

    return detailedJobs;
  } catch (error) {
    console.error("Error scraping NoDesk:", error);
    return [];
  }
}

/**
 * Fetches detailed job information from the individual job page.
 */
async function fetchNoDeskJobDetails(url: string): Promise<{
  description?: string;
  additionalTags?: string[];
  salary?: {
    min?: number;
    max?: number;
    estimated?: boolean;
    currency?: string;
  };
  applicationUrl?: string; // Added to store the real application URL
}> {
  try {
    const response = await axios.get(url);
    const $ = load(response.data);

    // Extract job description
    let description = "";

    // Look for the main content section that contains the job description
    const descriptionElement = $(
      "section.fr.mb8.mt4.mv0-ns.pl10-ns.w-100.w-two-thirds-ns .grey-800"
    );

    if (descriptionElement.length) {
      // Collect all paragraphs and lists in the description
      descriptionElement.find("p, ul, li, h2").each((_, paragraph) => {
        const paragraphText = $(paragraph).text().trim();
        if (paragraphText) {
          // If it's a heading (h2), make it stand out
          if (paragraph.tagName === "h2") {
            description += `\n### ${paragraphText}\n\n`;
          } else {
            description += paragraphText + "\n\n";
          }
        }
      });
    } else {
      // Alternative approach - look for any content that might be the job description
      const altDescriptionElement = $(
        "section.fr p, main p.f8.lh-relaxed, div.grey-800 p, div.grey-800 li"
      );
      if (altDescriptionElement.length) {
        altDescriptionElement.each((_, paragraph) => {
          const paragraphText = $(paragraph).text().trim();
          if (
            paragraphText &&
            !paragraphText.includes("Please let") &&
            !paragraphText.includes("NoDesk as a way to support us")
          ) {
            description += paragraphText + "\n\n";
          }
        });
      }
    }

    // Extract additional tags from the job detail page
    const additionalTags: string[] = [];
    $(
      "div.bb.b--indigo-050.pb3.pt4 ul.f9.list.mv0.pl0 li.dib a, div.bb.b--indigo-050.pb3.pt4 ul.f9.list.mv0.pl0 li.dib span"
    ).each((_, tagEl) => {
      const tag = $(tagEl).text().trim();
      if (tag) {
        additionalTags.push(tag);
      }
    });

    // Try to extract salary information from the job detail page if available
    let salary = undefined;

    // First, try to find salary info in the visible HTML
    const salaryText = $(
      "div.bb.b--indigo-050.pv4 .grey-700.mv0.tracked-wide, div.inline-flex.items-center p.grey-700.mv0.tracked-wide"
    )
      .text()
      .trim();

    if (salaryText && salaryText.includes("$")) {
      // Check for salary ranges like "$7.2K – $24K"
      const salaryMatch = salaryText.match(
        /\$(\d+(?:\.\d+)?)K\s*[–-]\s*\$(\d+(?:\.\d+)?)K/
      );
      if (salaryMatch) {
        salary = {
          min: parseFloat(salaryMatch[1]) * 1000,
          max: parseFloat(salaryMatch[2]) * 1000,
          currency: "USD",
          estimated: true,
        };
      } else {
        // Check for single salary like "$5K"
        const singleSalaryMatch = salaryText.match(/\$(\d+(?:\.\d+)?)K/);
        if (singleSalaryMatch) {
          const amount = parseFloat(singleSalaryMatch[1]) * 1000;
          salary = {
            min: amount,
            max: amount,
            currency: "USD",
            estimated: true,
          };
        }
      }
    }

    // Second attempt: Look for salary information in application/ld+json schema
    const schemaScripts = $('script[type="application/ld+json"]');

    if (schemaScripts.length && !salary) {
      for (let i = 0; i < schemaScripts.length; i++) {
        try {
          const content = $(schemaScripts[i]).html();
          if (!content) continue;

          // Clean the content - sometimes there are strange characters or comments
          const cleanedContent = content
            .replace(/\\/g, "\\\\") // Handle escaped backslashes
            .replace(/\\"/g, '\\"') // Handle escaped quotes
            .replace(/\n/g, " ") // Remove newlines
            .replace(/\/\*.*?\*\//g, "") // Remove comments
            .trim();

          const schemaData = JSON.parse(cleanedContent);

          if (schemaData && schemaData["@type"] === "JobPosting") {
            // Extract salary info
            if (schemaData.baseSalary) {
              let minValue, maxValue;
              let currency = "USD";

              // Handle different salary structures
              if (schemaData.baseSalary.value) {
                if (schemaData.baseSalary.value.minValue) {
                  minValue = schemaData.baseSalary.value.minValue;
                }
                if (schemaData.baseSalary.value.maxValue) {
                  maxValue = schemaData.baseSalary.value.maxValue;
                }
                if (schemaData.baseSalary.value.unitText === "YEAR") {
                  // Values are annual
                }
                if (schemaData.baseSalary.currency) {
                  currency = schemaData.baseSalary.currency;
                }
              } else {
                // Direct values
                minValue = schemaData.baseSalary.minValue;
                maxValue = schemaData.baseSalary.maxValue;
                if (schemaData.baseSalary.currency) {
                  currency = schemaData.baseSalary.currency;
                }
              }

              if (minValue || maxValue) {
                salary = {
                  min: minValue || undefined,
                  max: maxValue || undefined,
                  currency,
                  estimated: false, // Coming from schema, so not estimated
                };
              }
            }

            // If no description was found earlier, try to extract from schema
            if (!description && schemaData.description) {
              description = schemaData.description;
            }

            // Break once we've found valid job data
            break;
          }
        } catch (e) {
          console.error("Error parsing JSON-LD schema:", e);
        }
      }
    }

    // Extract the actual application URL from the "Apply Now" button
    let applicationUrl: string | undefined = undefined;

    // First try: Look for the Apply Now button in the job details section
    const applyButton = $(
      "a.dib.link.f8.fw5.dim.white.bg-indigo-500.br2.pa3.pa4-s.ph6-ns.pv4-ns.shadow-2.tracked-wider.ttu.w-auto, " +
        "div.pv4 a.dib.link.f9.f8-ns.fw5.dim.white.bg-indigo-500.br2.ph3.ph6-s.ph6-ns.pv2.pv3-s.pv3-ns.shadow-2.tracked-wider.ttu"
    );

    if (applyButton.length) {
      applicationUrl = applyButton.attr("href");

      // Check for onclick attribute that contains the URL
      const onClickAttr = applyButton.attr("onclick");
      if (!applicationUrl && onClickAttr && onClickAttr.includes("Apply:")) {
        // Extract URL from onclick if it's embedded there
        const urlMatch = onClickAttr.match(/href=['"]([^'"]+)['"]/);
        if (urlMatch) {
          applicationUrl = urlMatch[1];
        }
      }
    }

    // Second try: Check if there's a job application form or iframe
    if (!applicationUrl) {
      const applicationForm = $("form[action*='apply'], iframe[src*='apply']");
      if (applicationForm.length) {
        applicationUrl =
          applicationForm.attr("action") || applicationForm.attr("src");
      }
    }

    // If we still don't have the URL, try to find any link with text like "Apply"
    if (!applicationUrl) {
      $("a").each((_, element) => {
        const linkText = $(element).text().toLowerCase();
        if (
          (linkText.includes("apply") ||
            linkText.includes("application") ||
            linkText.includes("job")) &&
          !applicationUrl
        ) {
          applicationUrl = $(element).attr("href");
        }
      });
    }

    return {
      description: description.trim(),
      additionalTags,
      salary,
      applicationUrl,
    };
  } catch (error) {
    console.error(`Error fetching job details from ${url}:`, error);
    return {};
  }
}

/**
 * Scrapes jobs from TryRemote
 * HTML-based scraper targeting the specific markup structure
 */
export async function scrapeTryRemoteJobs(
  url: string = "https://tryremote.com/remote-worldwide-tech-jobs"
): Promise<ScrapedJob[]> {
  try {
    console.log(`Starting to scrape TryRemote from: ${url}`);
    const response = await axios.get(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
      },
    });

    const $ = load(response.data);
    const jobs: ScrapedJob[] = [];

    // Calculate the cutoff date (30 days ago)
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    // Target the job listing container divs based on the simplified HTML structure provided
    // Each job appears to be in a div with class "border border-solid flex"
    $("div.border.flex, div.border.border-solid.flex").each((_, element) => {
      try {
        // Extract job title - found in an h2 > a > span.text-2xl element
        const titleElement = $(element).find(
          "h2 a span.text-2xl, h2 a span.font-bold"
        );
        const title = titleElement.text().trim();

        // Extract company name - found in the first span inside the a element
        const companyElement = $(element).find(
          "h2 a span.text-lg, h2 a span:first-child"
        );
        let company = companyElement.text().trim();
        // Clean up the company name (removing "is hiring" if present)
        company = company
          .replace(/\s*is hiring\s*$/i, "")
          .replace(/\s*\<.*?\>\s*/g, "");

        // Extract job URL - from the anchor tag
        const jobLink = $(element).find("h2 a").attr("href");
        const fullJobURL = jobLink?.startsWith("http")
          ? jobLink
          : `https://tryremote.com${jobLink}`;

        // Extract location data
        const locationElements = $(element).find(
          'a.text-primaryGrey.opacity-70.uppercase, a[href*="remote-"]'
        );
        const locations: string[] = [];
        locationElements.each((_, locElement) => {
          const location = $(locElement)
            .text()
            .trim()
            .replace(/^[•\s]+/, ""); // Remove bullets
          if (location && !locations.includes(location)) {
            locations.push(location);
          }
        });

        // Extract skills/tags - from links with specific classes
        const tags: string[] = [];
        $(element)
          .find(
            "a.flex.items-center.gap-1.text-primaryGrey.bg-thirdGrey, a.rounded-xl"
          )
          .each((_, tagElement) => {
            const tag = $(tagElement).text().trim();
            if (tag && !tags.includes(tag)) {
              tags.push(tag);
            }
          });

        // Extract posted date/time - from a div with the time text
        let postedDate: Date | undefined = undefined;
        const timeText = $(element)
          .find("div.text-sm:last-child")
          .text()
          .trim();
        if (timeText) {
          if (timeText.includes("h")) {
            // For "Xh" format (hours)
            const hoursMatch = timeText.match(/(\d+)h/);
            if (hoursMatch && hoursMatch[1]) {
              const hoursAgo = parseInt(hoursMatch[1], 10);
              postedDate = new Date();
              postedDate.setHours(postedDate.getHours() - hoursAgo);
            }
          } else if (timeText.includes("d")) {
            // For "Xd" format (days)
            const daysMatch = timeText.match(/(\d+)d/);
            if (daysMatch && daysMatch[1]) {
              const daysAgo = parseInt(daysMatch[1], 10);
              postedDate = new Date();
              postedDate.setDate(postedDate.getDate() - daysAgo);
            }
          } else if (timeText.includes("w")) {
            // For "Xw" format (weeks)
            const weeksMatch = timeText.match(/(\d+)w/);
            if (weeksMatch && weeksMatch[1]) {
              const weeksAgo = parseInt(weeksMatch[1], 10);
              postedDate = new Date();
              postedDate.setDate(postedDate.getDate() - weeksAgo * 7);
            }
          }
        }

        // Skip jobs older than 30 days
        if (postedDate && postedDate < thirtyDaysAgo) {
          console.log(
            `Skipping job older than 30 days: ${title} at ${company}`
          );
          return; // Skip this job and continue with the next one
        }

        // Create the job object if we have the minimum required fields
        if (title && company && fullJobURL) {
          const job: ScrapedJob = {
            title,
            company,
            location: locations.length > 0 ? locations : ["Remote"], // Default to Remote if no location found
            url: fullJobURL,
            tags,
            source: "TryRemote",
            postedDate,
            scrapedDate: new Date(),
          };

          // Add job to the list
          jobs.push(job);
          console.log(`Found job: ${title} at ${company}`);
        }
      } catch (err) {
        console.error("Error parsing TryRemote job element:", err);
      }
    });

    // If we found jobs on the listing page, fetch their detailed descriptions
    const detailedJobs: ScrapedJob[] = [];

    for (let i = 0; i < jobs.length; i++) {
      try {
        console.log(
          `Fetching details for job ${i + 1}/${jobs.length}: ${jobs[i].title}`
        );
        const detailedJob = await fetchTryRemoteJobDetails(jobs[i]);

        // Additional check to make sure we don't include old jobs discovered from detail page
        if (detailedJob.postedDate && detailedJob.postedDate < thirtyDaysAgo) {
          console.log(
            `Skipping job older than 30 days (from details): ${detailedJob.title}`
          );
          continue;
        }

        detailedJobs.push(detailedJob);

        // Add delay between requests to avoid rate limiting
        await new Promise((resolve) => setTimeout(resolve, 1000));
      } catch (error) {
        console.error(`Error fetching details for ${jobs[i].title}:`, error);
        detailedJobs.push(jobs[i]); // Add the basic job without details
      }
    }

    console.log(
      `Successfully scraped ${detailedJobs.length} jobs from TryRemote`
    );
    return detailedJobs;
  } catch (error) {
    console.error("Error scraping TryRemote:", error);
    return [];
  }
}

/**
 * Fetches detailed job information from individual TryRemote job pages
 */
async function fetchTryRemoteJobDetails(job: ScrapedJob): Promise<ScrapedJob> {
  try {
    const response = await axios.get(job.url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
      },
    });

    const $ = load(response.data);

    // Extract job description from the main content area
    let description = "";
    $("main article, main section, main .job-description")
      .find("p, li, h1, h2, h3, h4, h5, h6, pre, code")
      .each((_, el) => {
        const text = $(el).text().trim();
        if (!text) return;

        if (el.tagName.match(/^h[1-6]$/i)) {
          description += `\n\n## ${text}\n\n`;
        } else if (el.tagName === "li") {
          description += `\n• ${text}`;
        } else if (el.tagName === "pre" || el.tagName === "code") {
          description += `\n\n\`\`\`\n${text}\n\`\`\`\n\n`;
        } else {
          description += `\n\n${text}`;
        }
      });

    // Clean up the description
    description = description.replace(/\n{3,}/g, "\n\n").trim();
    job.description = description;

    // Try to extract structured data if available
    $('script[type="application/ld+json"]').each((_, scriptEl) => {
      try {
        const jsonText = $(scriptEl).html();
        if (!jsonText) return;

        const jsonData = JSON.parse(jsonText);

        if (jsonData && jsonData["@type"] === "JobPosting") {
          // Extract job description if not already found
          if (!job.description && jsonData.description) {
            job.description = jsonData.description;
          }

          // Extract salary information if available
          if (jsonData.baseSalary) {
            const salaryInfo = jsonData.baseSalary;
            job.salary = {
              currency: salaryInfo.currency || "USD",
              estimated: false,
            };

            if (salaryInfo.value) {
              if (salaryInfo.value.minValue)
                job.salary.min = Number(salaryInfo.value.minValue);
              if (salaryInfo.value.maxValue)
                job.salary.max = Number(salaryInfo.value.maxValue);
            } else {
              if (salaryInfo.minValue)
                job.salary.min = Number(salaryInfo.minValue);
              if (salaryInfo.maxValue)
                job.salary.max = Number(salaryInfo.maxValue);
            }
          }

          // Extract additional skills/requirements
          if (
            Array.isArray(jsonData.skills) &&
            (!job.tags || job.tags.length === 0)
          ) {
            job.tags = jsonData.skills;
          }

          // Extract posting date if not already found
          if (!job.postedDate && jsonData.datePosted) {
            try {
              job.postedDate = new Date(jsonData.datePosted);
            } catch (e) {
              // Invalid date format, ignore
            }
          }
        }
      } catch (e) {
        // JSON parsing error, ignore
        console.warn("Error parsing JSON-LD:", e);
      }
    });

    return job;
  } catch (error) {
    console.error(`Error fetching details for ${job.url}:`, error);
    return job; // Return the basic job information if we couldn't get details
  }
}
